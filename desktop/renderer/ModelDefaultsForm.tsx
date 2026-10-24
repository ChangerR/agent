import { useId } from 'react';
import type { RuntimeSnapshot, SettingsSnapshot } from '../shared/protocol.js';
import { Field, Fields, type FormSchema } from './SchemaForm.js';

/** 默认模型是常用任务；继承与文件级高级选项留在次级入口。 */
export function ModelDefaultsForm({
  schema,
  value,
  effective,
  context,
  scope,
  onChange,
  manageModels,
  manageProviders,
}: {
  schema: FormSchema;
  value: Record<string, unknown>;
  effective: unknown;
  context?: RuntimeSnapshot | SettingsSnapshot;
  scope: 'global' | 'project';
  onChange: (value: unknown) => void;
  manageModels: () => void;
  manageProviders: () => void;
}) {
  const prefix = useId(),
    current = (effective ?? {}) as Record<string, unknown>;
  const fields = [
    ['provider', '服务连接'],
    ['model', '默认模型'],
    ['thinking', '思考等级'],
  ] as const;
  const model = String(value.model ?? current.model ?? ''),
    info = context?.modelDetails.find((m) => m.id === model);
  return (
    <>
      <div className="form-section-heading">
        <div>
          <h3>默认模型</h3>
          <p>用于新项目和新会话，现有会话保持当前选择。</p>
        </div>
        <button type="button" className="text-button" onClick={manageModels}>
          管理模型目录 ↗
        </button>
      </div>
      <div className="primary-model-fields">
        {fields.map(([name, title]) => (
          <div className="configuration-field primary-field" data-field={name} key={name}>
            <div className="primary-field-heading">
              <label htmlFor={prefix + name}>{title}</label>
              {Object.hasOwn(value, name) && (
                <button
                  type="button"
                  className="inherit-button"
                  aria-label={'恢复继承 ' + name}
                  title={
                    scope === 'global' ? '删除本层设置，恢复内置默认' : '删除项目覆盖，恢复全局继承'
                  }
                  onClick={() => {
                    const next = { ...value };
                    delete next[name];
                    onChange(next);
                  }}
                >
                  {scope === 'global' ? '使用默认' : '恢复继承'}
                </button>
              )}
            </div>
            <Field
              inputId={prefix + name}
              name={name}
              schema={{ ...schema.properties?.[name], title }}
              value={value[name] ?? current[name] ?? (name === 'thinking' ? 'off' : '')}
              runtime={context}
              onChange={(item) => onChange({ ...value, [name]: item })}
            />
            {name === 'provider' && (
              <button type="button" className="field-link" onClick={manageProviders}>
                管理服务连接
              </button>
            )}
            {name === 'model' && (
              <p className="field-hint">
                {info?.displayName ?? '可输入服务提供的模型 ID'}
                {info?.contextWindow ? ' · ' + info.contextWindow.toLocaleString() + ' 上下文' : ''}
                {info?.maxOutputTokens
                  ? ' · ' + info.maxOutputTokens.toLocaleString() + ' 最大输出'
                  : ''}
              </p>
            )}
          </div>
        ))}
      </div>
      <details className="advanced-fields">
        <summary>高级连接选项</summary>
        <Fields
          schema={{
            type: 'object',
            properties: Object.fromEntries(
              Object.entries(schema.properties ?? {}).filter(
                ([key]) => !fields.some(([name]) => name === key),
              ),
            ),
          }}
          value={value}
          effective={effective}
          runtime={context}
          onChange={onChange}
        />
      </details>
    </>
  );
}
