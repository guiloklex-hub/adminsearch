interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  pageSizeOptions?: number[];
}

const DEFAULT_OPTIONS = [25, 50, 100, 200];

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = DEFAULT_OPTIONS,
}: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);

  const canPrev = page > 1;
  const canNext = page < totalPages;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 12px',
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 8,
        fontSize: 13,
        color: 'var(--color-muted)',
        gap: 16,
        flexWrap: 'wrap',
      }}
    >
      <div>
        {total === 0 ? (
          'Nenhum item'
        ) : (
          <>
            <strong style={{ color: 'var(--color-text)' }}>
              {start.toLocaleString('pt-BR')}–{end.toLocaleString('pt-BR')}
            </strong>{' '}
            de <strong style={{ color: 'var(--color-text)' }}>{total.toLocaleString('pt-BR')}</strong>
          </>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {onPageSizeChange && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>Por página:</span>
            <select
              value={pageSize}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
              style={{
                background: 'var(--color-surface-2)',
                border: '1px solid var(--color-border)',
                color: 'var(--color-text)',
                padding: '3px 6px',
                borderRadius: 4,
                fontSize: 12,
              }}
            >
              {pageSizeOptions.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </label>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <PaginationButton disabled={!canPrev} onClick={() => onPageChange(1)} title="Primeira página">
            «
          </PaginationButton>
          <PaginationButton disabled={!canPrev} onClick={() => onPageChange(page - 1)} title="Anterior">
            ‹
          </PaginationButton>
          <span style={{ padding: '0 8px', color: 'var(--color-text)' }}>
            Pág. <strong>{page}</strong> de <strong>{totalPages}</strong>
          </span>
          <PaginationButton disabled={!canNext} onClick={() => onPageChange(page + 1)} title="Próxima">
            ›
          </PaginationButton>
          <PaginationButton disabled={!canNext} onClick={() => onPageChange(totalPages)} title="Última">
            »
          </PaginationButton>
        </div>
      </div>
    </div>
  );
}

function PaginationButton({
  disabled,
  onClick,
  title,
  children,
}: {
  disabled: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      style={{
        padding: '2px 8px',
        background: 'var(--color-surface-2)',
        border: '1px solid var(--color-border)',
        color: disabled ? 'var(--color-muted)' : 'var(--color-text)',
        borderRadius: 4,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        minWidth: 28,
        fontSize: 14,
      }}
    >
      {children}
    </button>
  );
}
