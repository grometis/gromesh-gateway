import { useState } from "react";
import { Field } from "../components/Field";
import { isObject, SECRET_PLACEHOLDER, type Config, type FieldErrors, type NamedField, type SchemaField } from "./schema";

interface Props {
  fields: NamedField[];
  value: Config;
  onChange: (value: Config) => void;
  errors: FieldErrors;
  /** Called with a path and whether its raw JSON input currently fails to parse. */
  onJsonError: (path: string, invalid: boolean) => void;
  path?: string;
}

/** Renders a record's fields from the plugin schema. Values the form does not show are kept as they are. */
export function SchemaFields({ fields, value, onChange, errors, onJsonError, path = "config" }: Props) {
  const visible = fields.filter(({ name, field }) => !field.deprecated || value[name] !== undefined);
  return (
    <>
      {visible.map(({ name, field }) => (
        <SchemaInput
          key={name}
          name={name}
          field={field}
          path={`${path}.${name}`}
          value={value[name]}
          onChange={(v) => {
            const next = { ...value };
            if (v === undefined) delete next[name];
            else next[name] = v;
            onChange(next);
          }}
          errors={errors}
          onJsonError={onJsonError}
        />
      ))}
    </>
  );
}

interface InputProps {
  name: string;
  field: SchemaField;
  path: string;
  value: unknown;
  onChange: (v: unknown) => void;
  errors: FieldErrors;
  onJsonError: (path: string, invalid: boolean) => void;
}

const KEPT_SECRET_HINT = "Valor atual mantido; digite para trocar.";

function label(name: string, field: SchemaField): string {
  return `${name}${field.required && field.default === undefined ? " *" : ""}${field.deprecated ? " (obsoleto)" : ""}`;
}

function SchemaInput(props: InputProps) {
  const { name, field, path, value, onChange, errors } = props;
  const fieldErrors = errors[path];
  const hint = field.description;
  // Whether this secret exists on the server (the API shows the placeholder instead of the value).
  const [stored] = useState(() => field.encrypted && value === SECRET_PLACEHOLDER);

  switch (field.type) {
    case "record":
      return (
        <fieldset className="record" data-path={path}>
          <legend>{label(name, field)}</legend>
          {hint && <small className="muted">{hint}</small>}
          {fieldErrors?.map((m) => (
            <small key={m} className="error" role="alert">
              {m}
            </small>
          ))}
          <SchemaFields fields={field.fields ?? []} value={isObject(value) ? value : {}} onChange={onChange} errors={errors} onJsonError={props.onJsonError} path={path} />
        </fieldset>
      );

    case "boolean":
      return (
        <div className="field">
          <label className="check">
            <input type="checkbox" checked={value === true} aria-invalid={!!fieldErrors} onChange={(e) => onChange(e.target.checked)} /> {label(name, field)}
          </label>
          {hint && !fieldErrors && <small className="muted">{hint}</small>}
          {fieldErrors?.map((m) => (
            <small key={m} className="error" role="alert">
              {m}
            </small>
          ))}
        </div>
      );

    case "number":
    case "integer":
      return (
        <Field label={label(name, field)} errors={fieldErrors} hint={hint}>
          {(id, invalid) => (
            <input
              id={id}
              type="number"
              step={field.type === "integer" ? 1 : "any"}
              aria-invalid={invalid}
              value={typeof value === "number" ? value : ""}
              onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
            />
          )}
        </Field>
      );

    case "string":
      return (
        <Field label={label(name, field)} errors={fieldErrors} hint={field.encrypted && value === SECRET_PLACEHOLDER ? KEPT_SECRET_HINT : hint}>
          {(id, invalid) =>
            field.oneOf ? (
              <select id={id} aria-invalid={invalid} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || undefined)}>
                {!(field.required && field.default !== undefined) && <option value="">(nenhum)</option>}
                {field.oneOf.map((o) => (
                  <option key={String(o)} value={String(o)}>
                    {String(o)}
                  </option>
                ))}
              </select>
            ) : field.encrypted ? (
              // Secrets are typed, never pre-filled with the placeholder the API returns. Clearing the input goes
              // back to the placeholder: a stored secret can be replaced here, not removed.
              <input
                id={id}
                type="password"
                autoComplete="new-password"
                aria-invalid={invalid}
                value={typeof value === "string" && value !== SECRET_PLACEHOLDER ? value : ""}
                onChange={(e) => onChange(e.target.value === "" && stored ? SECRET_PLACEHOLDER : e.target.value)}
              />
            ) : (
              <input id={id} aria-invalid={invalid} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} />
            )
          }
        </Field>
      );

    case "array":
    case "set": {
      const el = field.elements;
      const options = el?.oneOf?.map(String);
      if (options) return <OptionSet {...props} options={options} />;
      if (el && (el.type === "string" || el.type === "number" || el.type === "integer")) return <ListInput {...props} numeric={el.type !== "string"} />;
      return <JsonInput {...props} />;
    }

    case "map":
      if (field.values?.type === "string") return <MapInput {...props} />;
      return <JsonInput {...props} />;

    default:
      return <JsonInput {...props} />;
  }
}

function OptionSet({ name, field, path, value, onChange, errors, options }: InputProps & { options: string[] }) {
  const selected = Array.isArray(value) ? value.map(String) : [];
  return (
    <fieldset className="checks" data-path={path}>
      <legend>{label(name, field)}</legend>
      {options.map((o) => (
        <label key={o} className="check">
          <input type="checkbox" checked={selected.includes(o)} onChange={(e) => onChange(e.target.checked ? [...selected, o] : selected.filter((x) => x !== o))} /> {o}
        </label>
      ))}
      {errors[path]?.map((m) => (
        <small key={m} className="error" role="alert">
          {m}
        </small>
      ))}
    </fieldset>
  );
}

/** One item per line. The text is kept locally so a trailing newline survives while typing. */
function ListInput({ name, field, value, onChange, errors, path, numeric }: InputProps & { numeric: boolean }) {
  const [text, setText] = useState(() => (Array.isArray(value) ? value.map(String).join("\n") : ""));
  return (
    <Field label={label(name, field)} errors={errors[path]} hint={field.description ? `${field.description} (um por linha)` : "Um por linha"}>
      {(id, invalid) => (
        <textarea
          id={id}
          rows={2}
          aria-invalid={invalid}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            const items = e.target.value.split("\n").map((s) => s.trim()).filter(Boolean);
            onChange(numeric ? items.map((s) => (Number.isFinite(Number(s)) ? Number(s) : s)) : items);
          }}
        />
      )}
    </Field>
  );
}

/** `chave=valor`, one pair per line. */
function MapInput({ name, field, value, onChange, errors, path }: InputProps) {
  const [text, setText] = useState(() =>
    isObject(value)
      ? Object.entries(value)
          .map(([k, v]) => `${k}=${String(v)}`)
          .join("\n")
      : "",
  );
  return (
    <Field label={label(name, field)} errors={errors[path]} hint={field.description ? `${field.description} (chave=valor, um por linha)` : "chave=valor, um por linha"}>
      {(id, invalid) => (
        <textarea
          id={id}
          rows={2}
          aria-invalid={invalid}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            const out: Record<string, string> = {};
            for (const line of e.target.value.split("\n")) {
              const i = line.indexOf("=");
              if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
            }
            onChange(out);
          }}
        />
      )}
    </Field>
  );
}

/** Fallback for shapes the generator does not cover (lists of records, maps of records). */
function JsonInput({ name, field, value, onChange, errors, path, onJsonError }: InputProps) {
  const [text, setText] = useState(() => (value === undefined ? "" : JSON.stringify(value, null, 2)));
  const [invalid, setInvalid] = useState(false);
  return (
    <Field label={`${label(name, field)} (JSON)`} errors={invalid ? ["JSON inválido.", ...(errors[path] ?? [])] : errors[path]} hint={field.description}>
      {(id, hasErrors) => (
        <textarea
          id={id}
          className="mono"
          rows={3}
          aria-invalid={hasErrors}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (e.target.value.trim() === "") {
              setInvalid(false);
              onJsonError(path, false);
              onChange(undefined);
              return;
            }
            try {
              onChange(JSON.parse(e.target.value));
              setInvalid(false);
              onJsonError(path, false);
            } catch {
              setInvalid(true);
              onJsonError(path, true);
            }
          }}
        />
      )}
    </Field>
  );
}
