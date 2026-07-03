// Phase 12 · Slice 1 — RTL/jsdom render tests for the design-system primitives.
// Asserts behavior + accessibility semantics (roles, labels, aria) and variant wiring —
// not computed styles (jsdom does not process Tailwind CSS). Runs in the jsdom jest project.

import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  Button, Input, FormField, Badge, Alert, StatCard, ActionRow,
  Table, THead, TBody, TR, TH, TD, Tabs, Modal,
} from '@/components/ui';

describe('Button', () => {
  test('renders its label and fires onClick', async () => {
    const onClick = jest.fn();
    render(<Button variant="primary" onClick={onClick}>Provision</Button>);
    await userEvent.click(screen.getByRole('button', { name: 'Provision' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
  test('default type is button (not submit) and disabled blocks clicks', async () => {
    const onClick = jest.fn();
    render(<Button disabled onClick={onClick}>X</Button>);
    const btn = screen.getByRole('button', { name: 'X' });
    expect(btn).toHaveAttribute('type', 'button');
    expect(btn).toBeDisabled();
    await userEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('FormField + Input', () => {
  test('label is associated with the control; help renders', () => {
    render(<FormField label="Tenant name" htmlFor="tn" help="Legal name."><Input id="tn" /></FormField>);
    expect(screen.getByLabelText('Tenant name')).toBeInTheDocument();
    expect(screen.getByText('Legal name.')).toBeInTheDocument();
  });
  test('error takes precedence over help and is announced (role=alert)', () => {
    render(<FormField label="Price" htmlFor="p" help="ignored" error="Too low"><Input id="p" /></FormField>);
    expect(screen.getByRole('alert')).toHaveTextContent('Too low');
    expect(screen.queryByText('ignored')).not.toBeInTheDocument();
  });
});

describe('Badge / StatCard / ActionRow / Alert', () => {
  test('Badge renders content', () => {
    render(<Badge tone="danger">Expired</Badge>);
    expect(screen.getByText('Expired')).toBeInTheDocument();
  });
  test('StatCard shows label + value', () => {
    render(<StatCard label="Compliant" value="94%" delta="up 3" />);
    expect(screen.getByText('Compliant')).toBeInTheDocument();
    expect(screen.getByText('94%')).toBeInTheDocument();
    expect(screen.getByText('up 3')).toBeInTheDocument();
  });
  test('ActionRow renders title + description and fires onClick', async () => {
    const onClick = jest.fn();
    render(<ActionRow title="2 vendors expired" description="pulled from hireable" onClick={onClick} />);
    await userEvent.click(screen.getByRole('button', { name: /2 vendors expired/ }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
  test('danger Alert has role=alert; info Alert has role=status', () => {
    const { rerender } = render(<Alert tone="danger" title="Boom">bad</Alert>);
    expect(screen.getByRole('alert')).toHaveTextContent('Boom');
    rerender(<Alert tone="info" title="FYI">ok</Alert>);
    expect(screen.getByRole('status')).toHaveTextContent('FYI');
  });
});

describe('Table', () => {
  test('renders rows and marks sortable headers with aria-sort', () => {
    render(
      <Table>
        <THead><TR><TH sort="asc">Vendor</TH><TH>Trade</TH><TH sort={null}>Status</TH></TR></THead>
        <TBody><TR><TD>Acme</TD><TD>Plumbing</TD><TD>Approved</TD></TR></TBody>
      </Table>
    );
    expect(screen.getByRole('columnheader', { name: /Vendor/ })).toHaveAttribute('aria-sort', 'ascending');
    expect(screen.getByRole('columnheader', { name: /Status/ })).toHaveAttribute('aria-sort', 'none'); // sortable, unsorted
    expect(screen.getByRole('columnheader', { name: 'Trade' })).not.toHaveAttribute('aria-sort'); // not sortable
    expect(screen.getByRole('cell', { name: 'Acme' })).toBeInTheDocument();
  });
});

describe('Tabs', () => {
  test('marks the active tab and fires onChange on click', async () => {
    const onChange = jest.fn();
    render(<Tabs value="a" onChange={onChange} tabs={[{ id: 'a', label: 'To review', count: 12 }, { id: 'b', label: 'All' }]} />);
    expect(screen.getByRole('tab', { name: /To review/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'false');
    await userEvent.click(screen.getByRole('tab', { name: 'All' }));
    expect(onChange).toHaveBeenCalledWith('b');
  });
});

describe('Modal', () => {
  test('is not rendered when closed', () => {
    render(<Modal open={false} onClose={() => {}} title="T">body</Modal>);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  test('renders when open; Esc, overlay click, and the close button call onClose; content click does not', async () => {
    const onClose = jest.fn();
    render(<Modal open onClose={onClose} title="Confirm">body</Modal>);
    expect(screen.getByRole('dialog', { name: 'Confirm' })).toBeInTheDocument();

    await userEvent.click(screen.getByText('body')); // content — must NOT close
    expect(onClose).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByTestId('modal-overlay')); // overlay
    expect(onClose).toHaveBeenCalledTimes(2);

    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
