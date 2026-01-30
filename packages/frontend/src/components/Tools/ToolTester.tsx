import { useState, useCallback, useMemo, type FormEvent } from "react";
import type { ToolDefinition, JsonSchemaProperty } from "@vladbot/shared";
import { executeTools } from "../../services/api.js";

interface ToolTesterProps {
  tools: ToolDefinition[];
}

export default function ToolTester({ tools }: ToolTesterProps) {
  const [selectedTool, setSelectedTool] = useState<ToolDefinition | null>(
    tools[0] ?? null,
  );
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);

  const operationNames = useMemo(
    () => (selectedTool ? Object.keys(selectedTool.operations) : []),
    [selectedTool],
  );
  const isMultiOp = operationNames.length > 1;
  const selectedOp = isMultiOp ? formValues["operation"] ?? "" : operationNames[0];

  // Get current operation's params and required set
  const { params, requiredSet } = useMemo(() => {
    if (!selectedTool || !selectedOp || !selectedTool.operations[selectedOp]) {
      return { params: [] as [string, JsonSchemaProperty][], requiredSet: new Set<string>() };
    }
    const op = selectedTool.operations[selectedOp];
    return {
      params: Object.entries(op.params),
      requiredSet: new Set(op.required ?? []),
    };
  }, [selectedTool, selectedOp]);

  const handleToolChange = useCallback(
    (name: string) => {
      const tool = tools.find((t) => t.name === name) ?? null;
      setSelectedTool(tool);
      setFormValues({});
      setResult(null);
      setIsError(false);
    },
    [tools],
  );

  const setField = useCallback((key: string, value: string) => {
    setFormValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleExecute = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!selectedTool || !selectedOp) return;

      setExecuting(true);
      setResult(null);
      setIsError(false);

      const op = selectedTool.operations[selectedOp];
      if (!op) return;

      const args: Record<string, unknown> = {};
      if (isMultiOp) args.operation = selectedOp;

      for (const [key, schema] of Object.entries(op.params)) {
        const raw = formValues[key];
        if (raw === undefined || raw === "") continue;

        if (schema.type === "number") {
          args[key] = Number(raw);
        } else if (schema.type === "boolean") {
          args[key] = raw === "true";
        } else if (schema.type === "array") {
          args[key] = raw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        } else {
          args[key] = raw;
        }
      }

      try {
        const res = await executeTools({
          toolCalls: [
            {
              id: `test-${Date.now()}`,
              name: selectedTool.name,
              arguments: args,
            },
          ],
        });
        const out = res.results[0];
        if (out.isError) {
          setIsError(true);
          setResult(out.output);
        } else {
          try {
            setResult(JSON.stringify(JSON.parse(out.output), null, 2));
          } catch {
            setResult(out.output);
          }
        }
      } catch (err) {
        setIsError(true);
        setResult(err instanceof Error ? err.message : "Execution failed");
      } finally {
        setExecuting(false);
      }
    },
    [selectedTool, selectedOp, isMultiOp, formValues],
  );

  if (tools.length === 0) {
    return (
      <div className="tool-tester">
        <div className="tool-tester-empty">No tools available</div>
      </div>
    );
  }

  return (
    <div className="tool-tester">
      <form className="tool-tester-form" onSubmit={handleExecute}>
        <div className="tool-tester-header">
          <label className="tool-param-label">
            Tool
            <select
              className="tool-select"
              value={selectedTool?.name ?? ""}
              onChange={(e) => handleToolChange(e.target.value)}
            >
              {tools.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="tool-execute-btn"
            disabled={executing || !selectedTool || !selectedOp}
          >
            {executing ? "Executing..." : "Execute"}
          </button>
        </div>

        {selectedTool && (
          <p className="tool-description">{selectedTool.description}</p>
        )}

        {isMultiOp && (
          <label className="tool-param-label">
            operation *
            <select
              className="tool-param-select"
              value={selectedOp}
              onChange={(e) => setField("operation", e.target.value)}
            >
              <option value="">-- select --</option>
              {operationNames.map((op) => (
                <option key={op} value={op}>
                  {op}
                </option>
              ))}
            </select>
          </label>
        )}

        {params.length > 0 && (
          <div className="tool-params">
            {params.map(([key, schema]) => (
              <ParamField
                key={key}
                name={key}
                schema={schema}
                required={requiredSet.has(key)}
                value={formValues[key] ?? ""}
                onChange={(val) => setField(key, val)}
              />
            ))}
          </div>
        )}
      </form>

      <div className="tool-result-container">
        {result !== null ? (
          <>
            <div className="tool-result-header">
              <span>Result</span>
              <button
                className="tool-result-clear"
                onClick={() => {
                  setResult(null);
                  setIsError(false);
                }}
              >
                Clear
              </button>
            </div>
            <pre className={`tool-result${isError ? " tool-result-error" : ""}`}>
              {result}
            </pre>
          </>
        ) : (
          <div className="tool-result-placeholder">
            Execute a tool to see results
          </div>
        )}
      </div>
    </div>
  );
}

function ParamField({
  name,
  schema,
  required,
  value,
  onChange,
}: {
  name: string;
  schema: JsonSchemaProperty;
  required: boolean;
  value: string;
  onChange: (val: string) => void;
}) {
  const label = `${name}${required ? " *" : ""}`;
  const desc = schema.description;

  if (schema.enum) {
    return (
      <label className="tool-param-label">
        {label}
        {desc && <span className="tool-param-desc">{desc}</span>}
        <select
          className="tool-param-select"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">-- select --</option>
          {schema.enum.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (schema.type === "boolean") {
    return (
      <label className="tool-param-label">
        {label}
        {desc && <span className="tool-param-desc">{desc}</span>}
        <select
          className="tool-param-select"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">-- default --</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      </label>
    );
  }

  if (schema.type === "number") {
    return (
      <label className="tool-param-label">
        {label}
        {desc && <span className="tool-param-desc">{desc}</span>}
        <input
          className="tool-param-input"
          type="number"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={name}
        />
      </label>
    );
  }

  if (schema.type === "array") {
    return (
      <label className="tool-param-label">
        {label}
        {desc && <span className="tool-param-desc">{desc}</span>}
        <input
          className="tool-param-input"
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="comma-separated values"
        />
      </label>
    );
  }

  const useLong = /text|body|content|description|command/i.test(name);

  if (useLong) {
    return (
      <label className="tool-param-label">
        {label}
        {desc && <span className="tool-param-desc">{desc}</span>}
        <textarea
          className="tool-param-textarea"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={name}
          rows={4}
        />
      </label>
    );
  }

  return (
    <label className="tool-param-label">
      {label}
      {desc && <span className="tool-param-desc">{desc}</span>}
      <input
        className="tool-param-input"
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={name}
      />
    </label>
  );
}
