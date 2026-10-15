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
