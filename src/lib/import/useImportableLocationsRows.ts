'use client';

// Shared table-state hook for the editable store+manager import (Slice 12/5b, Feature 1). One
// hook, two visual skins: the ProvisioningWizard (platform, design-system components) and the
// tenant-Admin bulk-add-locations screen (unmigrated inline-style tenant app — FENCE:
// migration-only, ADR-012-01) render their own markup around the same state/logic.

import { useState, useCallback, useMemo } from 'react';
import { emptyImportRow, validateTable, type ImportLocationRow } from './location-rows';

export function useImportableLocationsRows(initial: ImportLocationRow[] = [emptyImportRow()]) {
  const [rows, setRows] = useState<ImportLocationRow[]>(initial);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const table = useMemo(() => validateTable(rows), [rows]);

  const updateRow = useCallback((i: number, patch: Partial<ImportLocationRow>) => {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }, []);
  const addRow = useCallback(() => setRows((prev) => [...prev, emptyImportRow()]), []);
  const removeRow = useCallback((i: number) => setRows((prev) => prev.filter((_, idx) => idx !== i)), []);

  /** Appends parsed rows from an uploaded file — populates the table, does not create anything. */
  const uploadFile = useCallback(async (file: File, parseEndpoint: string) => {
    setUploading(true);
    setUploadError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(parseEndpoint, { method: 'POST', body: formData });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setUploadError((body as { error?: string }).error ?? `Could not read this file (${res.status})`);
        return;
      }
      const parsedRows = (body as { data: ImportLocationRow[] }).data;
      setRows((prev) => {
        const withoutTrailingBlank = prev.filter((r) => !isRowEmpty(r));
        return [...withoutTrailingBlank, ...parsedRows, emptyImportRow()];
      });
    } catch {
      setUploadError('Network error — the file was not read.');
    } finally {
      setUploading(false);
    }
  }, []);

  return { rows, table, updateRow, addRow, removeRow, uploadFile, uploading, uploadError };
}

function isRowEmpty(r: ImportLocationRow): boolean {
  return !r.storeName.trim() && !r.address.trim() && !r.managerFirstName.trim() && !r.managerLastName.trim() && !r.managerEmail.trim();
}
