// Verification worker — the fourth queue-shaped worker (alongside notification, audit-export).
// Same claim-then-process model: a per-row guarded UPDATE ... WHERE status='queued' is the
// atomicity boundary (see notifications/worker.ts's module doc for the full reasoning — this
// worker reuses it verbatim, not a new pattern).
//
// 1. Reclaim: rows stuck in 'processing' past the stale window (a crashed worker) → 'queued'.
// 2. Claim: atomic UPDATE 'queued' → 'processing' (claimed_at=now); only one claim wins.
// 3. Process: extract every active document that has no extraction yet, then runVerification().
//    On success → 'done'. On failure → 'failed' (error captured, never crashes the loop/worker).
//
// Expiration gate (invariant #6 — "an expired policy bounces to the vendor and never reaches
// the Admin"): previously enforced synchronously at upload, before the vendor could ever reach
// submit. Moving extraction here means a COI's expiration is only knowable after this worker's
// Vision call — extractor.ts's own checkExpirationGate() doc comment already anticipated this
// ("Fires AFTER extraction, BEFORE verification run enqueue"). A bounce found here reopens the
// vendor's (already under_review) locations back to 'onboarding' with action_needed — the same
// status value and flag request_correction already uses (src/lib/services/decision.ts), not a
// new FSM state — and skips runVerification() for this job; the job still completes as 'done'
// (a bounce is a valid terminal outcome, not a worker failure).

import { randomUUID } from 'crypto';
import type { Db } from '@/lib/db/client';
import { TenantDB } from '@/lib/db/tenant';
import { getBlobStore } from '@/lib/blob';
import { decryptFromStorage, type EncryptionMeta } from '@/lib/crypto/envelope';
import { extractDocument, checkExpirationGate } from '@/lib/extraction/extractor';
import { earliestExpiration, handleCoiUploadChase, supersedePriorDocument } from '@/lib/notifications/renewal';
import { queueNotification } from '@/lib/notifications/queue';
import { runVerification, type VerificationTrigger } from './run';
import { logAudit } from '@/lib/audit';
import { captureSecurityAlert } from '@/lib/observability';
import { env } from '@/lib/env';
import type { ProcessedCOIExtraction } from '@/lib/extraction/types';

export interface VerificationWorkerTickResult {
  reclaimed: number;
  processed: number;
  failed: number;
}

interface QueuedJobRow {
  id: string;
  tenant_id: string;
  vendor_id: string;
  trigger: string;
}

interface PendingDocRow {
  id: string;
  doc_type: 'coi' | 'w9' | 'ach';
  storage_key: string;
  encryption_json: EncryptionMeta;
}

interface ExtractionOutcome {
  bounced: boolean;
}

/** Extract every active, not-yet-extracted document for this vendor. Mirrors exactly what used
 *  to run inline per-upload in documents/route.ts, just batched here per submitted job. */
async function extractPendingDocuments(db: Db, tenantId: string, vendorId: string): Promise<ExtractionOutcome> {
  const tdb = new TenantDB(db, tenantId);

  const docs = await tdb.all<PendingDocRow>(
    `SELECT d.id, d.doc_type, d.storage_key, d.encryption_json
     FROM documents d
     WHERE d.tenant_id = $1 AND d.vendor_id = $2 AND d.state = 'active' AND d.superseded_by IS NULL
       AND d.doc_type IN ('coi', 'w9', 'ach')
       AND NOT EXISTS (
         SELECT 1 FROM extractions e WHERE e.tenant_id = d.tenant_id AND e.document_id = d.id
       )`,
    [vendorId]
  );

  let bounced = false;

  for (const doc of docs) {
    const ciphertext = await getBlobStore().get(doc.storage_key);
    const pdfBytes = decryptFromStorage(ciphertext, doc.encryption_json);

    const extraction = await extractDocument(pdfBytes, doc.doc_type);

    const extractionId = randomUUID();
    await tdb.insert('extractions', {
      id: extractionId,
      document_id: doc.id,
      doc_type: doc.doc_type,
      model_id: extraction.modelId,
      extraction_version: env.anthropic.extractionSchemaVersion,
      payload_json: JSON.stringify(extraction.payload),
      created_at: new Date(),
    });

    await logAudit(db, {
      tenantId,
      actorType: 'ai',
      actorId: `engine/${extraction.modelId}`,
      eventType: 'document.extracted',
      targetType: 'document',
      targetId: doc.id,
      payload: {
        doc_type: doc.doc_type,
        extraction_id: extractionId,
        model_id: extraction.modelId,
        escalated: extraction.escalated,
      },
    });

    if (doc.doc_type === 'coi') {
      const gate = checkExpirationGate(extraction.payload as ProcessedCOIExtraction);
      if (!gate.passed) {
        // Bounce-before-supersede: an expired replacement must NOT displace a still-valid
        // prior COI, or the vendor would be left with zero active COIs until they upload
        // again. supersedePriorDocument only ever runs once the gate has passed.
        await bounceExpiredCOI(db, tenantId, vendorId, doc.id, gate.expiredPolicies);
        bounced = true;
        continue; // other pending docs (w9/ach) still extract normally
      }

      const coiPayload = extraction.payload as ProcessedCOIExtraction;
      const expDate = earliestExpiration(coiPayload);
      if (expDate) {
        await handleCoiUploadChase(db, {
          tenantId,
          vendorId,
          newDocumentId: doc.id,
          expirationDate: expDate,
        });
      } else {
        // No parseable expiration date — the reminder ladder can't be scheduled, but the
        // document is still valid (gate passed) and must still supersede the prior COI so
        // two active rows of the same type never coexist.
        await supersedePriorDocument(db, { tenantId, vendorId, docType: 'coi', newDocumentId: doc.id });
      }
    } else {
      // w9/ach have no expiration gate — supersede the prior active row of the same type
      // as soon as this upload has successfully extracted.
      await supersedePriorDocument(db, { tenantId, vendorId, docType: doc.doc_type, newDocumentId: doc.id });
    }
  }

  return { bounced };
}

/** Bounce an expired COI back to the vendor post-submit — same audit event / notification type
 *  the old inline upload-time gate used (documents/route.ts), plus reopening the vendor's
 *  under_review locations, which the old path never needed (it always fired before submit). */
async function bounceExpiredCOI(
  db: Db,
  tenantId: string,
  vendorId: string,
  documentId: string,
  expiredPolicies: string[]
): Promise<void> {
  const tdb = new TenantDB(db, tenantId);

  await tdb.update('documents', { state: 'bounced_expired' }, { id: documentId });

  await logAudit(db, {
    tenantId,
    actorType: 'system',
    actorId: 'expiration-gate',
    eventType: 'document.bounced_expired',
    targetType: 'document',
    targetId: documentId,
    payload: { vendor_id: vendorId, expired_policies: expiredPolicies },
  });

  const underReview = await tdb.all<{ location_id: string; flags_json: Record<string, unknown> | null }>(
    `SELECT location_id, flags_json FROM vendor_locations WHERE tenant_id = $1 AND vendor_id = $2 AND status = 'under_review'`,
    [vendorId]
  );
  for (const vl of underReview) {
    const flags = vl.flags_json ? { ...vl.flags_json } : {};
    flags.action_needed = true;
    await tdb.update(
      'vendor_locations',
      { status: 'onboarding', flags_json: JSON.stringify(flags) },
      { vendor_id: vendorId, location_id: vl.location_id }
    );
  }

  const vendor = await tdb.get<{ contact_email: string | null }>(
    'SELECT contact_email FROM vendors WHERE tenant_id = $1 AND id = $2',
    [vendorId]
  );
  if (vendor?.contact_email) {
    await queueNotification(db, tenantId, {
      recipientType: 'vendor',
      recipientRef: vendor.contact_email,
      kind: 'exception',
      payload: {
        type: 'document_bounced_expired',
        vendor_id: vendorId,
        doc_type: 'coi',
        expired_policies: expiredPolicies,
      },
    });
  }
}

export async function processQueuedVerificationJobs(
  db: Db,
  now: Date = new Date(),
  opts: { staleSeconds?: number } = {}
): Promise<VerificationWorkerTickResult> {
  const staleSeconds = opts.staleSeconds ?? env.notifications.sendingStaleSeconds;
  const staleCutoff = new Date(now.getTime() - staleSeconds * 1000);

  // 1. Reclaim stale 'processing' rows (a crashed worker left them).
  const reclaimRes = await db
    .updateTable('verification_jobs')
    .set({ status: 'queued', claimed_at: null })
    .where('status', '=', 'processing')
    .where('claimed_at', 'is not', null)
    .where('claimed_at', '<=', staleCutoff)
    .executeTakeFirst();
  const reclaimed = Number(reclaimRes.numUpdatedRows);

  // 2. Discovery — not a claim; the per-row guarded UPDATE below is the real atomicity boundary.
  const due = (await db
    .selectFrom('verification_jobs')
    .select(['id', 'tenant_id', 'vendor_id', 'trigger'])
    .where('status', '=', 'queued')
    .orderBy('created_at', 'asc')
    .execute()) as QueuedJobRow[];

  let processed = 0;
  let failed = 0;

  for (const row of due) {
    // 3. Claim — if another pass already took it, numUpdatedRows===0, skip.
    const claimRes = await db
      .updateTable('verification_jobs')
      .set({ status: 'processing', claimed_at: now })
      .where('id', '=', row.id)
      .where('status', '=', 'queued')
      .executeTakeFirst();
    if (Number(claimRes.numUpdatedRows) === 0) continue;

    try {
      const { bounced } = await extractPendingDocuments(db, row.tenant_id, row.vendor_id);

      if (!bounced) {
        const tdb = new TenantDB(db, row.tenant_id);
        const vendor = await tdb.get<{ trade: string }>(
          'SELECT trade FROM vendors WHERE tenant_id = $1 AND id = $2',
          [row.vendor_id]
        );
        if (!vendor) throw new Error(`vendor ${row.vendor_id} not found`);

        await runVerification(db, {
          tenantId: row.tenant_id,
          vendorId: row.vendor_id,
          vendorTrade: vendor.trade,
          trigger: row.trigger as VerificationTrigger,
        });
      }

      await db
        .updateTable('verification_jobs')
        .set({ status: 'done', completed_at: new Date(), claimed_at: null })
        .where('id', '=', row.id)
        .execute();
      processed++;
    } catch (err) {
      const message = (err as Error).message;
      await db
        .updateTable('verification_jobs')
        .set({ status: 'failed', error: message, claimed_at: null })
        .where('id', '=', row.id)
        .execute();
      // OPS-3-shaped: a verification-job failure is an ops signal, same as notification/export
      // failures. IDs + message only.
      captureSecurityAlert('verification_job.failed', {
        tenant_id: row.tenant_id, vendor_id: row.vendor_id, job_id: row.id, error: message,
      });
      failed++;
    }
  }

  return { reclaimed, processed, failed };
}

export interface VerificationWorkerHandle {
  stop: () => void;
}

export function startVerificationWorker(
  db: Db,
  intervalSeconds: number = env.notifications.workerPollSeconds
): VerificationWorkerHandle {
  const timer = setInterval(() => {
    void processQueuedVerificationJobs(db)
      .then((result) => {
        console.log('[verification-worker] tick ok, processed', result.processed + result.failed);
      })
      .catch((err) => {
        console.error('[verification-worker] tick failed:', err);
      });
  }, intervalSeconds * 1000);
  if (typeof timer.unref === 'function') timer.unref();
  return { stop: () => clearInterval(timer) };
}
