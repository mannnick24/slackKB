import React, { useEffect, useId, useMemo, useRef, useState } from "react";

export type MultiSelectOption = {
  value: string;
  label: string;
};

type MultiSelectSearchProps = {
  label: string;
  placeholder?: string;
  options: MultiSelectOption[];
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  minWidth?: number;
};

export function MultiSelectSearch({
  label,
  placeholder = "Search…",
  options,
  value,
  onChange,
  disabled = false,
  minWidth = 200,
}: MultiSelectSearchProps) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const selectedSet = useMemo(() => new Set(value), [value]);
  const optionByValue = useMemo(() => new Map(options.map((o) => [o.value, o])), [options]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q)
    );
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  function toggle(val: string) {
    if (selectedSet.has(val)) {
      onChange(value.filter((v) => v !== val));
    } else {
      onChange([...value, val]);
    }
  }

  function remove(val: string) {
    onChange(value.filter((v) => v !== val));
  }

  const soleValue = value.length === 1 ? value[0] : undefined;
  const triggerLabel =
    value.length === 0
      ? "Any"
      : soleValue !== undefined
        ? (optionByValue.get(soleValue)?.label ?? soleValue)
        : `${value.length} selected`;

  return (
    <div ref={rootRef} style={{ display: "flex", flexDirection: "column", gap: 4, minWidth }}>
      <span style={{ fontSize: 13 }}>{label}</span>
      <button
        type="button"
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={listId}
        onClick={() => {
          if (disabled) return;
          setOpen((o) => !o);
          if (open) setQuery("");
        }}
        style={{
          textAlign: "left",
          padding: "6px 10px",
          fontSize: 13,
          border: "1px solid #ccc",
          borderRadius: 6,
          background: disabled ? "#f3f4f6" : "#fff",
          cursor: disabled ? "not-allowed" : "pointer",
          width: "100%",
        }}
      >
        {triggerLabel}
      </button>

      {value.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {value.map((v) => {
            const lbl = optionByValue.get(v)?.label ?? v;
            return (
              <span
                key={v}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  fontSize: 11,
                  padding: "2px 6px",
                  borderRadius: 4,
                  background: "#e5e7eb",
                }}
              >
                {lbl}
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`Remove ${lbl}`}
                  onClick={() => remove(v)}
                  style={{
                    border: "none",
                    background: "transparent",
                    cursor: disabled ? "not-allowed" : "pointer",
                    padding: 0,
                    lineHeight: 1,
                    fontSize: 14,
                  }}
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      )}

      {open && !disabled && (
        <div
          style={{
            position: "relative",
            zIndex: 20,
          }}
        >
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              border: "1px solid #ccc",
              borderRadius: 6,
              background: "#fff",
              boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
              maxHeight: 240,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={placeholder}
              style={{
                margin: 8,
                padding: "6px 8px",
                fontSize: 13,
                border: "1px solid #ddd",
                borderRadius: 4,
              }}
            />
            <ul
              id={listId}
              role="listbox"
              aria-multiselectable
              style={{
                listStyle: "none",
                margin: 0,
                padding: "0 0 8px",
                overflowY: "auto",
                flex: 1,
              }}
            >
              {filtered.length === 0 ? (
                <li style={{ padding: "8px 12px", fontSize: 12, opacity: 0.7 }}>No matches</li>
              ) : (
                filtered.map((o) => {
                  const checked = selectedSet.has(o.value);
                  return (
                    <li key={o.value} role="option" aria-selected={checked}>
                      <label
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          padding: "6px 12px",
                          cursor: "pointer",
                          fontSize: 13,
                          background: checked ? "#eff6ff" : "transparent",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggle(o.value)}
                        />
                        <span style={{ wordBreak: "break-word" }}>{o.label}</span>
                      </label>
                    </li>
                  );
                })
              )}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
