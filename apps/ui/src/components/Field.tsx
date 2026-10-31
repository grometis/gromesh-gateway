import { useId, type ReactNode } from "react";

/** Label + control + the 422 messages the API returned for this field. */
export function Field({ label, errors, hint, children }: { label: string; errors?: string[]; hint?: string; children: (id: string, invalid: boolean) => ReactNode }) {
  const id = useId();
  const invalid = (errors?.length ?? 0) > 0;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id, invalid)}
      {hint && !invalid && <small className="muted">{hint}</small>}
      {errors?.map((m) => (
        <small key={m} className="error" role="alert">
          {m}
        </small>
      ))}
    </div>
  );
}

export function FormErrorList({ messages }: { messages: string[] }) {
  if (messages.length === 0) return null;
  return (
    <ul className="error form-errors" role="alert">
      {messages.map((m) => (
        <li key={m}>{m}</li>
      ))}
    </ul>
  );
}

/** Checkbox label and field feedback, shared by enabled, preserveHost and other boolean fields. */
export function CheckboxField({ label, errors, checked, onChange }: {
  label: string; errors?: string[]; checked: boolean; onChange: (checked: boolean) => void;
}) {
  const id = useId();
  const invalid = (errors?.length ?? 0) > 0;
  const errorId = `${id}-errors`;
  return (
    <div className="field">
      <label className="check" htmlFor={id}>
        <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-invalid={invalid} aria-describedby={invalid ? errorId : undefined} /> {label}
      </label>
      {invalid && <div id={errorId} role="alert">
        {errors!.map((message) => <small key={message} className="error">{message}</small>)}
      </div>}
    </div>
  );
}
