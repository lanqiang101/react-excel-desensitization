import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Check,
  CircleHelp,
  CloudOff,
  Database,
  Download,
  Eye,
  FileSpreadsheet,
  Files,
  FolderOpen,
  LockKeyhole,
  MoreHorizontal,
  Play,
  Plus,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  desensitizeFile,
  detectModelState,
  getModelStatus,
  readPreview,
  type DesensitizationRule,
  type MaskMode,
  type PreviewTable,
} from '@/services/desensitizer';
import { sampleTables } from '@/data/sampleTables';

type Rule = DesensitizationRule & { example: string };
type ProcessedFile = { file: File; blob: Blob; original: PreviewTable; masked: PreviewTable };
const initialRules: Rule[] = [
  { key: 'phone', label: '手机号', example: '138****5678', enabled: true },
  { key: 'idCard', label: '身份证号', example: '110***********1234', enabled: true },
  { key: 'email', label: '邮箱地址', example: 'l***@example.com', enabled: true },
  { key: 'address', label: '详细地址', example: '北京市朝阳区****', enabled: false },
  { key: 'name', label: '中文姓名', example: '张**', enabled: true },
  { key: 'company', label: '公司名称', example: '某某****', enabled: true },
];

const PreviewPane: React.FC<{
  title: string;
  tone: 'original' | 'masked';
  table: PreviewTable;
}> = ({ title, tone, table }) => (
  <div className={`preview-pane ${tone}`}>
    <div className="preview-pane-heading">
      <strong>{title}</strong>
      <span>{table.rows.length} 行预览</span>
    </div>
    <div className="preview-table-wrap">
      <table>
        <thead>
          <tr>
            {table.headers.map((header, index) => (
              <th key={`${header}-${index}`}>{header || `列 ${index + 1}`}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {table.headers.map((_, columnIndex) => (
                <td key={columnIndex}>{row[columnIndex] ?? ''}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </div>
);

const Home: React.FC = () => {
  const inputRef = useRef<HTMLInputElement>(null);
  const previewSectionRef = useRef<HTMLElement | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [rules, setRules] = useState(initialRules);
  const [mode, setMode] = useState<MaskMode>('替换');
  const [template, setTemplate] = useState('标准个人信息');
  const [isRunning, setIsRunning] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [error, setError] = useState('');
  const [modelStatus, setModelStatus] = useState(getModelStatus());
  const [selectedSample, setSelectedSample] = useState(sampleTables[0].id);
  const [pastedCsv, setPastedCsv] = useState('');
  const [processedFiles, setProcessedFiles] = useState<ProcessedFile[]>([]);
  const [previewIndex, setPreviewIndex] = useState(0);

  useEffect(() => {
    detectModelState().then(setModelStatus);
  }, []);

  const addFiles = (incoming: FileList | File[]) => {
    const validFiles = Array.from(incoming).filter((file) => /\.(csv|xlsx)$/i.test(file.name));
    setFiles((current) => [
      ...current,
      ...validFiles.filter((file) => !current.some((item) => item.name === file.name)),
    ]);
    setIsComplete(false);
    setProcessedFiles([]);
  };

  const loadSample = () => {
    const sample = sampleTables.find((item) => item.id === selectedSample);
    if (sample) setPastedCsv(sample.csv);
  };

  const importPastedCsv = () => {
    const content = pastedCsv.trim();
    if (!content) {
      setError('请先粘贴 CSV 数据，或载入一个内置示例');
      return;
    }
    addFiles([new File([content], 'pasted-data.csv', { type: 'text/csv;charset=utf-8' })]);
    setError('');
  };

  const startProcessing = async () => {
    if (!files.length) return;
    setIsRunning(true);
    setIsComplete(false);
    setError('');
    try {
      const outputRules = rules.map(({ key, label, enabled }) => ({ key, label, enabled }));
      const results: ProcessedFile[] = [];
      for (const file of files) {
        const blob = await desensitizeFile(file, outputRules, mode);
        results.push({
          file,
          blob,
          original: await readPreview(file),
          masked: await readPreview(blob),
        });
      }
      setProcessedFiles(results);
      setPreviewIndex(0);
      setIsComplete(true);
      requestAnimationFrame(() => {
        previewSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    } catch {
      setError('文件处理失败，请确认文件格式正确后重试');
    } finally {
      setIsRunning(false);
    }
  };

  const downloadPreview = (result: ProcessedFile) => {
    const url = URL.createObjectURL(result.blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${result.file.name.replace(/\.(csv|xlsx)$/i, '')}.masked.xlsx`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const toggleRule = (index: number) =>
    setRules((current) =>
      current.map((item, itemIndex) =>
        itemIndex === index ? { ...item, enabled: !item.enabled } : item
      )
    );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-mark">
          <ShieldCheck size={19} strokeWidth={2.5} />
        </div>
        <div className="brand-copy">
          <strong>隐数台</strong>
          <span>DATA MASKER</span>
        </div>
        <div className="side-nav">
          <button className="nav-item active">
            <Files size={17} />
            脱敏工作台
          </button>
          <button className="nav-item">
            <Database size={17} />
            任务记录<span className="nav-count">12</span>
          </button>
          <button className="nav-item">
            <SlidersHorizontal size={17} />
            规则模板
          </button>
        </div>
        <div className="side-bottom">
          <div className="privacy-note">
            <CloudOff size={16} />
            <span>
              全程本地处理
              <br />
              <small>原始文件不上传</small>
            </span>
          </div>
          <button className="nav-item">
            <Settings2 size={17} />
            偏好设置
          </button>
          <div className="user-chip">
            <span className="avatar">XQ</span>
            <span>本地工作区</span>
            <MoreHorizontal size={16} />
          </div>
        </div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">LOCAL WORKSPACE / 01</p>
            <h1>脱敏工作台</h1>
          </div>
          <div className="top-actions">
            <span className="local-status">
              <span className="status-dot" />
              本地模式
            </span>
            <button className="icon-button" aria-label="帮助">
              <CircleHelp size={18} />
            </button>
          </div>
        </header>
        <div className="content-grid">
          <section className="main-column">
            <div className="section-heading">
              <div>
                <h2>导入文件</h2>
                <p>支持批量处理 CSV、XLSX 文件</p>
              </div>
              <span className="step-label">STEP 01</span>
            </div>
            <div
              className={`dropzone ${files.length ? 'has-files' : ''}`}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                addFiles(event.dataTransfer.files);
              }}
            >
              <input
                ref={inputRef}
                type="file"
                accept=".csv,.xlsx"
                multiple
                hidden
                onChange={(event) => event.target.files && addFiles(event.target.files)}
              />
              <div className="upload-icon">
                <Upload size={23} />
              </div>
              <div>
                <strong>{files.length ? `${files.length} 个文件已准备` : '拖放文件到这里'}</strong>
                <span>或点击选择本地文件</span>
              </div>
              <button className="outline-button" onClick={() => inputRef.current?.click()}>
                <FolderOpen size={16} />
                选择文件
              </button>
            </div>
            {!!files.length && (
              <div className="file-list">
                {files.map((file) => (
                  <div className="file-row" key={file.name}>
                    <FileSpreadsheet size={18} />
                    <span>{file.name}</span>
                    <small>{(file.size / 1024).toFixed(1)} KB</small>
                    <button
                      aria-label={`移除 ${file.name}`}
                      onClick={() =>
                        setFiles((current) => current.filter((item) => item.name !== file.name))
                      }
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="paste-panel">
              <div className="paste-heading">
                <div>
                  <strong>粘贴表格数据</strong>
                  <span>支持 CSV 文本，保留逗号、引号和多行字段格式</span>
                </div>
                <span className="paste-badge">LOCAL ONLY</span>
              </div>
              <div className="sample-controls">
                <select
                  aria-label="选择内置示例"
                  value={selectedSample}
                  onChange={(event) => setSelectedSample(event.target.value)}
                >
                  {sampleTables.map((sample) => (
                    <option key={sample.id} value={sample.id}>
                      {sample.title}
                    </option>
                  ))}
                </select>
                <span>
                  {sampleTables.find((sample) => sample.id === selectedSample)?.description}
                </span>
                <button className="text-button" onClick={loadSample}>
                  载入示例
                </button>
              </div>
              <textarea
                aria-label="粘贴 CSV 数据"
                value={pastedCsv}
                onChange={(event) => setPastedCsv(event.target.value)}
                placeholder="将 CSV 内容粘贴到这里，例如：序号,姓名,手机号..."
              />
              <div className="paste-footer">
                <small>建议使用 UTF-8 with BOM；数据仅在当前浏览器内存中处理</small>
                <button className="outline-button compact" onClick={importPastedCsv}>
                  <Plus size={15} />
                  导入粘贴数据
                </button>
              </div>
            </div>
            <div className="section-heading rules-heading">
              <div>
                <h2>脱敏规则</h2>
                <p>选择需要处理的字段和脱敏方式</p>
              </div>
              <span className="step-label">STEP 02</span>
            </div>
            <div className="rules-panel">
              <div className="template-row">
                <div>
                  <span className="field-label">规则模板</span>
                  <strong>{template}</strong>
                </div>
                <select value={template} onChange={(event) => setTemplate(event.target.value)}>
                  <option>标准个人信息</option>
                  <option>仅联系方式</option>
                  <option>自定义模板</option>
                </select>
                <button className="small-icon-button" aria-label="新增模板">
                  <Plus size={16} />
                </button>
              </div>
              <div className="rule-list">
                {rules.map((rule, index) => (
                  <div className="rule-row" key={rule.label}>
                    <div
                      className={`rule-check ${rule.enabled ? 'checked' : ''}`}
                      onClick={() => toggleRule(index)}
                    >
                      {rule.enabled && <Check size={13} />}
                    </div>
                    <span className="rule-name">{rule.label}</span>
                    <span className="rule-example">{rule.example}</span>
                    <button
                      className="toggle"
                      aria-label={`切换${rule.label}`}
                      aria-pressed={rule.enabled}
                      onClick={() => toggleRule(index)}
                    >
                      <span />
                    </button>
                  </div>
                ))}
              </div>
              <button className="custom-rule">
                <Plus size={15} />
                添加自定义规则 <ArrowRight size={14} />
              </button>
            </div>
          </section>
          <aside className="summary-column">
            <div className="summary-card">
              <div className="card-topline">
                <span className="step-label">STEP 03</span>
                <Sparkles size={18} />
              </div>
              <h2>准备处理</h2>
              <p>确认配置后，生成一份新的脱敏文件。原始文件保持不变。</p>
              <div className="summary-stats">
                <div>
                  <strong>{files.length.toString().padStart(2, '0')}</strong>
                  <span>待处理文件</span>
                </div>
                <div>
                  <strong>
                    {rules
                      .filter((rule) => rule.enabled)
                      .length.toString()
                      .padStart(2, '0')}
                  </strong>
                  <span>启用规则</span>
                </div>
              </div>
              <div className="mode-label">脱敏方式</div>
              <div className="mode-switch">
                {['替换', '置空', '随机'].map((item) => (
                  <button
                    key={item}
                    className={mode === item ? 'selected' : ''}
                    onClick={() => setMode(item as MaskMode)}
                  >
                    {item}
                  </button>
                ))}
              </div>
              <button
                className="primary-button"
                disabled={!files.length || isRunning}
                onClick={startProcessing}
              >
                {isRunning ? '正在处理...' : isComplete ? '处理完成' : '开始脱敏'}
                {isComplete ? <Check size={17} /> : <Play size={15} fill="currentColor" />}
              </button>
              {isComplete && (
                <div className="success-message">
                  <Eye size={15} />
                  已生成脱敏结果，请先完成下方预览确认
                </div>
              )}
            </div>
            <div className="tip-card">
              <div className="tip-icon">
                <LockKeyhole size={16} />
              </div>
              <div>
                <strong>隐私保护提示</strong>
                <p>文件仅在当前浏览器内存中处理，不会上传到任何服务器。</p>
              </div>
            </div>
            <div className="model-status">
              <Sparkles size={14} />
              <span>智能扫描：{modelStatus.reason}</span>
            </div>
            {error && <div className="processing-error">{error}</div>}
          </aside>
        </div>
        {!!processedFiles.length && (
          <section ref={previewSectionRef} className="preview-section">
            <div className="preview-heading">
              <div>
                <p className="eyebrow">REVIEW BEFORE EXPORT</p>
                <h2>脱敏结果预览</h2>
                <span>左右对比原始数据与脱敏后的数据，确认无误后再下载。</span>
              </div>
              <div className="preview-actions">
                <select
                  aria-label="选择预览文件"
                  value={previewIndex}
                  onChange={(event) => setPreviewIndex(Number(event.target.value))}
                >
                  {processedFiles.map((result, index) => (
                    <option key={result.file.name} value={index}>
                      {result.file.name}
                    </option>
                  ))}
                </select>
                <button
                  className="primary-button preview-download"
                  onClick={() => downloadPreview(processedFiles[previewIndex])}
                >
                  <Download size={16} />
                  下载脱敏数据
                </button>
              </div>
            </div>
            <div className="comparison-grid">
              <PreviewPane
                title="原始数据"
                tone="original"
                table={processedFiles[previewIndex].original}
              />
              <PreviewPane
                title="脱敏后数据"
                tone="masked"
                table={processedFiles[previewIndex].masked}
              />
            </div>
          </section>
        )}
      </main>
    </div>
  );
};

export default Home;
