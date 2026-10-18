const paths = {
  folder: 'M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z',
  plus: 'M12 5v14M5 12h14',
  panel: 'M4 4h16v16H4ZM15 4v16',
  sidebar: 'M4 4h16v16H4ZM9 4v16',
  message: 'M4 5h16v12H9l-5 4Z',
  settings:
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4',
  chevron: 'm9 6 6 6-6 6',
  arrow: 'M12 19V5m-6 6 6-6 6 6',
  grid: 'M4 4h6v6H4ZM14 4h6v6h-6ZM4 14h6v6H4ZM14 14h6v6h-6Z',
  terminal: 'm5 7 5 5-5 5M13 17h6',
  monitor: 'M3 4h18v13H3ZM8 21h8M12 17v4',
  stop: 'M6 6h12v12H6Z',
  code: 'm8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18',
  moon: 'M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z',
} as const;

/** 统一的线性图标，避免平台字体导致符号大小和基线不一致。 */
export function Icon({ name, size = 16 }: { name: keyof typeof paths; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="icon"
    >
      <path d={paths[name]} />
    </svg>
  );
}
