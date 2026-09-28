export const showcase = [
  {
    id: '01', label: 'Deny', title: 'A denial you can verify.', decision: 'Denied',
    starts: '0', effects: '0', status: 'Passed', complete: true,
    name: 'Denied. Nothing executed.', detail: 'Zero starts. Zero effects. Complete evidence.',
    note: 'The completed ledger and independent resource probe agree.',
  },
  {
    id: '02', label: 'Approve', title: 'One approval. One execution.', decision: 'Approved',
    starts: '1', effects: '1', status: 'Passed', complete: true,
    name: 'Approved. Executed once.', detail: 'One tool execution and one local effect.',
    note: 'One tool execution matches one change in the local note store.',
  },
  {
    id: '03', label: 'Fault', title: 'The UI says no. The tool runs.', decision: 'Denied',
    starts: '1', effects: '1', status: 'Failed', complete: true,
    name: 'Denied. Still executed.', detail: 'The ledger and resource expose the fault.',
    note: 'The injected fault is caught even though the UI claims denial.',
  },
  {
    id: '04', label: 'Missing', title: 'No evidence is not evidence of no.', decision: 'Denied',
    starts: '?', effects: '?', status: 'Failed', complete: false,
    name: 'Denied. Incomplete ledger.', detail: 'A missing barrier cannot establish zero.',
    note: 'Without a completion barrier, zero executions cannot be proven.',
  },
] as const;
