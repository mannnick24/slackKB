import React from "react";

// export function Field({
//   label,
//   value,
//   onChange,
//   type = "text"
// }: {
//   label: string;
//   value: string;
//   onChange: (v: string) => void;
//   type?: string;
// }) {
//   return (
//     <label style={{ display: "block", marginBottom: 10 }}>
//       <div style={{ fontSize: 12, opacity: 0.8 }}>{label}</div>
//       <input
//         style={{ width: "100%", padding: 8, border: "1px solid #ccc", borderRadius: 6 }}
//         type={type}
//         value={value}
//         onChange={(e) => onChange(e.target.value)}
//       />
//     </label>
//   );
// }

// export function Field({
//   label,
//   value,
//   onChange,
//   type = "text",
//   step,
//   min,
//   max
// }: {
//   label: string;
//   value: string;
//   onChange: (v: string) => void;
//   type?: string;
//   step?: number;
//   min?: number;
//   max?: number;
// }) {
//   return (
//     <label style={{ display: "block", marginBottom: 10 }}>
//       <div style={{ fontSize: 12, opacity: 0.8 }}>{label}</div>
//       <input
//         type={type}
//         value={value}
//         step={step}
//         min={min}
//         max={max}
//         onChange={(e) => onChange(e.target.value)}
//         style={{
//           width: "100%",
//           padding: 8,
//           border: "1px solid #ccc",
//           borderRadius: 6
//         }}
//       />
//     </label>
//   );
// }

export function Field({
  label,
  value,
  onChange,
  type = "text",
  step,
  min,
  max,
  multiline = false,
  rows = 4,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  step?: number;
  min?: number;
  max?: number;

  // NEW
  multiline?: boolean;
  rows?: number;
}) {
  return (
    <label style={{ display: "block", marginBottom: 10 }}>
      <div style={{ fontSize: 12, opacity: 0.8 }}>{label}</div>

      {multiline ? (
        <textarea
          value={value}
          rows={rows}
          onChange={(e) => onChange(e.target.value)}
          style={{
            width: "100%",
            padding: 8,
            border: "1px solid #ccc",
            borderRadius: 6,
            resize: "vertical",
          }}
        />
      ) : (
        <input
          type={type}
          value={value}
          step={step}
          min={min}
          max={max}
          onChange={(e) => onChange(e.target.value)}
          style={{
            width: "100%",
            padding: 8,
            border: "1px solid #ccc",
            borderRadius: 6,
          }}
        />
      )}
    </label>
  );
}

