import type { ReactNode } from 'react';

/** Ícones em traço (24×24), no estilo dos ícones do n8n. */
const PATHS: Record<string, ReactNode> = {
  flows: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
      <path d="M10 6.5h4a3 3 0 0 1 3 3V14" />
    </>
  ),
  executions: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M10 8.5v7l5.5-3.5z" />
    </>
  ),
  connections: (
    <>
      <path d="M9 15l6-6" />
      <path d="M11 6l1.5-1.5a4 4 0 0 1 5.7 5.7L16.5 12" />
      <path d="M13 18l-1.5 1.5a4 4 0 0 1-5.7-5.7L7.5 12" />
    </>
  ),
  erp: (
    <>
      <rect x="3" y="4" width="18" height="6" rx="1.5" />
      <rect x="3" y="14" width="18" height="6" rx="1.5" />
      <path d="M7 7h.01M7 17h.01" />
    </>
  ),
  sql: (
    <>
      <ellipse cx="12" cy="5.5" rx="8" ry="2.5" />
      <path d="M4 5.5v13c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-13" />
      <path d="M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5" />
    </>
  ),
  clients: (
    <>
      <path d="M3 21V8l9-5 9 5v13" />
      <path d="M9 21v-6h6v6" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6" />
    </>
  ),
  folders: <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z" />,
  audit: (
    <>
      <path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z" />
      <path d="M8.5 12l2.5 2.5 4.5-5" />
    </>
  ),
  logout: (
    <>
      <path d="M15 4h3.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H15" />
      <path d="M10 8l-4 4 4 4M6 12h10" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  back: <path d="M15 5l-7 7 7 7" />,
  play: <path d="M7 4.5v15l12-7.5z" />,
  // Nós
  manualTrigger: <path d="M13 2L5 13.5h6L10 22l8-11.5h-6z" />,
  scheduleTrigger: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  executeWorkflowTrigger: (
    <>
      <path d="M14 4h4.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H14" />
      <path d="M9 8l4 4-4 4M3 12h10" />
    </>
  ),
  executeWorkflow: (
    <>
      <path d="M10 4H5.5A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20H10" />
      <path d="M15 8l4 4-4 4M9 12h10" />
    </>
  ),
  httpRequest: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z" />
    </>
  ),
  if: (
    <>
      <path d="M4 12h5l3-6h8M12 18h8M9 12l3 6" />
      <path d="M17 3l3 3-3 3M17 15l3 3-3 3" />
    </>
  ),
  loop: (
    <>
      <path d="M17 2l3 3-3 3" />
      <path d="M4 11V9a4 4 0 0 1 4-4h12" />
      <path d="M7 22l-3-3 3-3" />
      <path d="M20 13v2a4 4 0 0 1-4 4H4" />
    </>
  ),
  code: <path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16" />,
  splitOut: (
    <>
      <path d="M3 12h6M9 12l5-6h7M9 12l5 6h7M9 12h12" />
    </>
  ),
  aggregate: (
    <>
      <path d="M3 6h7l5 6-5 6H3M3 12h18" />
    </>
  ),
  merge: (
    <>
      <path d="M4 5h4l5 7h7M4 19h4l5-7" />
      <path d="M17 9l3 3-3 3" />
    </>
  ),
  editFields: (
    <>
      <path d="M4 20h4L19 9l-4-4L4 16z" />
      <path d="M13 7l4 4" />
    </>
  ),
  stopAndError: (
    <>
      <path d="M8 3h8l5 5v8l-5 5H8l-5-5V8z" />
      <path d="M12 8v5M12 16h.01" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="5.5" rx="8" ry="2.5" />
      <path d="M4 5.5v13c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-13" />
      <path d="M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5" />
    </>
  ),
  metabase: (
    <>
      <path d="M4 20V10M9.3 20V4M14.7 20v-7M20 20V7" />
    </>
  ),
  clickup: (
    <>
      <path d="M4 16.5l3-2.3c1.6 2 3.1 3 5 3s3.4-1 5-3l3 2.3c-2.3 3-4.8 4.5-8 4.5s-5.7-1.5-8-4.5z" />
      <path d="M12 7.5l-5.5 4.7-2.5-2.9L12 3l8 6.3-2.5 2.9z" />
    </>
  ),
  gmail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3.5 6.5L12 13l8.5-6.5" />
    </>
  ),
  filter: <path d="M3 5h18l-7 8v6l-4 2v-8z" />,
  switch: (
    <>
      <path d="M3 12h6M9 12l4-6h8M9 12h12M9 12l4 6h8" />
      <circle cx="9" cy="12" r="1.5" />
    </>
  ),
  compareDatasets: (
    <>
      <circle cx="9" cy="12" r="6" />
      <circle cx="15" cy="12" r="6" />
    </>
  ),
  wait: (
    <>
      <circle cx="12" cy="13" r="8" />
      <path d="M12 9v4l3 2M9 2h6" />
    </>
  ),
  noOp: <path d="M5 12h14M15 8l4 4-4 4" />,
  executionData: (
    <>
      <path d="M4 4h16v16H4z" />
      <path d="M8 9h8M8 13h8M8 17h5" />
    </>
  ),
  limit: <path d="M4 6h16M4 10h16M4 14h10M4 19h16" />,
  sort: <path d="M7 4v16M4 17l3 3 3-3M14 6h7M14 11h5M14 16h3" />,
  removeDuplicates: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M4 16V6a2 2 0 0 1 2-2h10M11 14h6" />
    </>
  ),
  renameKeys: (
    <>
      <path d="M4 7h9M4 12h6M4 17h9" />
      <path d="M15 17l5-5-3-3-5 5v3z" />
    </>
  ),
  summarize: <path d="M18 4H6l6 8-6 8h12" />,
  dateTime: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4M12 14v3h3" />
    </>
  ),
  crypto: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4M12 15v2" />
    </>
  ),
  html: <path d="M8 7l-5 5 5 5M16 7l5 5-5 5M10 19l4-14" />,
  markdown: (
    <>
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M6 15V9l2.5 3L11 9v6M15 9v6M13 13l2 2 2-2" />
    </>
  ),
  xml: (
    <>
      <path d="M7 8l-4 4 4 4M17 8l4 4-4 4" />
      <path d="M10 10l4 4M14 10l-4 4" />
    </>
  ),
  totp: (
    <>
      <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />
      <path d="M12 8v4l2 2" />
    </>
  ),
  convertToFile: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M12 11v6M9 14l3 3 3-3" />
    </>
  ),
  extractFromFile: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M12 17v-6M9 14l3-3 3 3" />
    </>
  ),
  iCal: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4M8 14h3v3H8z" />
    </>
  ),
  compression: (
    <>
      <path d="M21 8v13H3V8M1 3h22v5H1zM10 12h4" />
    </>
  ),
  editImage: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="M21 15l-5-5L5 21" />
    </>
  ),
  readWriteFile: (
    <>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M12 10v6M9 13h6" />
    </>
  ),
  webhook: (
    <>
      <path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2" />
      <path d="M6 17l3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06" />
      <path d="M12 6l3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8" />
    </>
  ),
  respondToWebhook: (
    <>
      <path d="M9 14L4 9l5-5" />
      <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
    </>
  ),
  formTrigger: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </>
  ),
  form: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 9l2 2 4-4M8 15h8" />
    </>
  ),
  errorTrigger: (
    <>
      <path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  n8nTrigger: (
    <>
      <path d="M13 2L3 14h9l-1 8 10-12h-9z" />
    </>
  ),
  rssFeedReadTrigger: (
    <>
      <path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16" />
      <circle cx="5" cy="19" r="1" />
    </>
  ),
  emailReadImap: (
    <>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M22 7l-10 6L2 7" />
    </>
  ),
  localFileTrigger: (
    <>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <circle cx="12" cy="13" r="2.5" />
    </>
  ),
  sseTrigger: (
    <>
      <path d="M2 12h3l3-8 4 16 3-8h7" />
    </>
  ),
  emailSend: (
    <>
      <path d="M22 2L11 13" />
      <path d="M22 2l-7 20-4-9-9-4z" />
    </>
  ),
  ftp: (
    <>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M9 13l3-3 3 3M12 10v6" />
    </>
  ),
  ssh: (
    <>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M6 9l3 3-3 3M12 15h6" />
    </>
  ),
  executeCommand: (
    <>
      <path d="M4 17l6-6-6-6M12 19h8" />
    </>
  ),
  git: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="9" r="2.5" />
      <path d="M6 8.5v7M18 11.5c0 3-3 3.5-9.5 5" />
    </>
  ),
  rssFeedRead: (
    <>
      <path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16" />
      <circle cx="5" cy="19" r="1" />
    </>
  ),
  info8n: (
    <>
      <path d="M7 12h4c1.3 0 1.8-.9 2.4-2 .6-1.1 1.1-1.8 2.3-1.8M11 12c1.3 0 1.8.9 2.4 2 .6 1.1 1.1 1.8 2.3 1.8" />
      <circle cx="5" cy="12" r="2.2" />
      <circle cx="18" cy="8" r="2.2" />
      <circle cx="18" cy="16" r="2.2" />
    </>
  ),
  dataTable: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M3 14.5h18M9 9v11" />
    </>
  ),
  unknown: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01" />
    </>
  ),
};

/** Cor do ícone de cada tipo de nó, como no n8n cada nó tem a sua. */
export const NODE_COLOR: Record<string, string> = {
  manualTrigger: '#f29423',
  scheduleTrigger: '#1ea97c',
  executeWorkflowTrigger: '#f29423',
  executeWorkflow: '#ec5b62',
  httpRequest: '#378ef0',
  if: '#1ea97c',
  loop: '#1ea97c',
  code: '#6b6f80',
  splitOut: '#378ef0',
  aggregate: '#378ef0',
  merge: '#0e9ce3',
  editFields: '#378ef0',
  stopAndError: '#ec5b62',
  database: '#336791',
  metabase: '#509ee3',
  clickup: '#7b68ee',
  gmail: '#ea4335',
  filter: '#229eff',
  switch: '#506000',
  compareDatasets: '#506000',
  wait: '#ff6d5a',
  noOp: '#b0b0b0',
  executionData: '#29a568',
  limit: '#3e8abd',
  sort: '#3e8abd',
  removeDuplicates: '#3e8abd',
  renameKeys: '#3e8abd',
  summarize: '#3e8abd',
  dateTime: '#408000',
  crypto: '#408000',
  html: '#e44d26',
  markdown: '#555555',
  xml: '#333377',
  totp: '#2b6cb0',
  convertToFile: '#7a5af8',
  extractFromFile: '#7a5af8',
  iCal: '#d14836',
  compression: '#8a6d3b',
  editImage: '#c2185b',
  readWriteFile: '#5c6bc0',
  webhook: '#c94a73',
  respondToWebhook: '#c94a73',
  formTrigger: '#ff6d5a',
  form: '#ff6d5a',
  errorTrigger: '#ec5b62',
  n8nTrigger: '#ea4b71',
  rssFeedReadTrigger: '#f26522',
  emailReadImap: '#0078d4',
  localFileTrigger: '#5c6bc0',
  sseTrigger: '#6b6f80',
  emailSend: '#0078d4',
  ftp: '#5c6bc0',
  ssh: '#333333',
  executeCommand: '#333333',
  git: '#f05032',
  rssFeedRead: '#f26522',
  info8n: '#378ef0',
  dataTable: '#29a568',
};

export function Icon({ name, size = 18, className }: { name: string; size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name] ?? PATHS.unknown}
    </svg>
  );
}

/** Marca do Info8n: três nós ligados, como o logotipo do n8n, no azul do IPA. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="#378ef0" />
      <g fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round">
        <path d="M10.5 16h4.5c1.5 0 2-1 2.8-2.4.7-1.3 1.3-2.1 2.7-2.1M15 16c1.5 0 2 1 2.8 2.4.7 1.3 1.3 2.1 2.7 2.1" />
      </g>
      <g fill="#fff">
        <circle cx="8" cy="16" r="2.8" />
        <circle cx="22.6" cy="11.5" r="2.8" />
        <circle cx="22.6" cy="20.5" r="2.8" />
      </g>
    </svg>
  );
}
