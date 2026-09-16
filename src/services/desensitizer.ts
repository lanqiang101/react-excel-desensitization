import * as XLSX from 'xlsx';
import { initializeModelScanner, scanText } from './modelScanner';

export type MaskMode = '替换' | '置空' | '随机';
export type RuleKey = 'phone' | 'idCard' | 'email' | 'address' | 'name' | 'company';
export type ModelState = 'MODEL_READY' | 'MODEL_UNAVAILABLE' | 'MODEL_DEGRADED';

export type DesensitizationRule = {
  key: RuleKey;
  label: string;
  enabled: boolean;
};

export type ModelStatus = {
  state: ModelState;
  reason: string;
  fallbackActive: boolean;
};

export type VerificationReport = {
  clean: boolean;
  totalLeaks: number;
  leaks: Array<{ sheet: string; row: number; column: string; type: RuleKey }>;
};

export type PreviewTable = {
  headers: string[];
  rows: string[][];
};

export type ModelEntity = {
  text: string;
  label: string;
  confidence: number;
  start: number;
  end: number;
};

const MODEL_PATH = '/models/rampart/model.onnx';
const TOKENIZER_PATH = '/models/rampart/tokenizer.json';
const CONFIG_PATH = '/models/rampart/config.json';
const VOCAB_PATH = '/models/rampart/vocab.txt';
const SPECIAL_TOKENS_PATH = '/models/rampart/special_tokens_map.json';
const EXPECTED_MODEL_SHA256 = '8341930b1c41fb05ffffc737c334cb78ff073c161a7806654a944d7355be893b';
const EXPECTED_TOKENIZER_SHA256 =
  'cb374d6bc042c22455946f4e09a89d29882a199fdaf8fb25be00dc8b8857a448';
const EXPECTED_CONFIG_SHA256 = '22c375dbfba06d02a9997ef336bb06c8a7aaaea9ae66934773fe1b4bd5735678';

const headerAliases: Record<RuleKey, string[]> = {
  phone: ['手机号', '手机', '电话', '联系电话', 'mobile', 'phone'],
  idCard: ['身份证', '身份证号', '证件号', 'idcard', 'identity'],
  email: ['邮箱', '电子邮箱', 'email', 'mail'],
  address: ['地址', '详细地址', '住址', 'address', '备注', '描述'],
  name: ['姓名', '联系人', '负责人', '经办人', '申请人', '作者', '收件人', '寄件人', 'name'],
  company: ['公司', '单位', '机构', '企业', 'company', 'organization'],
};

const patterns: Partial<Record<RuleKey, RegExp>> = {
  phone: /1[3-9]\d{9}/g,
  idCard: /\d{17}[\dXx]|\d{15}/g,
  email: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
  address:
    /(?:中国)?(?:北京市|上海市|天津市|重庆市|[黑吉辽冀晋鲁豫苏皖浙闽赣鄂湘粤桂琼川贵云陕甘青宁新藏蒙])[\u4e00-\u9fff\d]{2,}(?:区|县|市|镇|乡|路|街|号)[\u4e00-\u9fff\d\s-]{0,24}/g,
  company:
    /[A-Za-z0-9]{2,30}(?:有限公司|股份有限公司|有限责任公司|集团|科技|网络|信息|技术|文化|传媒)/g,
};

const commonSurnames = new Set(
  '王李张刘陈杨赵黄周吴徐孙胡朱高林何郭马罗梁宋郑谢韩唐冯于董萧程曹袁邓许傅沈曾彭吕苏卢蒋蔡贾丁魏薛叶阎余潘杜戴夏钟汪田任姜范方石姚谭廖邹熊金陆郝孔白崔康毛邱秦江史顾侯邵孟龙万段雷钱汤尹黎易常武乔贺赖龚文'.split(
    ''
  )
);
const compoundSurnames = ['欧阳', '司马', '诸葛', '上官', '皇甫', '令狐', '慕容', '司徒'];
const nonPiiWords = new Set([
  '测试',
  '示例',
  '未知',
  '无',
  'n/a',
  'null',
  '--',
  '公司',
  '部门',
  '备注',
  '说明',
  '默认',
  '产品',
  '服务',
  '系统',
  '平台',
]);
const confidenceThresholds: Record<string, number> = {
  PERSON_NAME: 0.75,
  ADDRESS: 0.7,
  ORGANIZATION: 0.8,
  PHONE: 0.9,
  EMAIL: 0.9,
  DEFAULT: 0.75,
};

const randomMask = (length: number) =>
  Array.from({ length }, () => Math.floor(Math.random() * 10)).join('');

async function readWorkbookFromBlob(
  source: Blob,
  options: XLSX.ParsingOptions = {}
): Promise<XLSX.WorkBook> {
  const sourceName = source instanceof File ? source.name : '';
  const type = (source.type || '').toLowerCase();
  const isCsvLike = /\.csv$/i.test(sourceName) || type.includes('csv');
  const buffer = await source.arrayBuffer();

  if (isCsvLike) {
    const text = new TextDecoder('utf-8').decode(new Uint8Array(buffer)).replace(/^\uFEFF/, '');
    return XLSX.read(text, { type: 'string', raw: false, ...options });
  }

  return XLSX.read(buffer, { type: 'array', raw: false, ...options });
}

function maskValue(value: string, key: RuleKey, mode: MaskMode): string {
  if (mode === '置空') return '';
  if (mode === '随机') return randomMask(value.length);
  if (key === 'phone') return `${value.slice(0, 3)}****${value.slice(-4)}`;
  if (key === 'idCard')
    return `${value.slice(0, 3)}${'*'.repeat(Math.max(0, value.length - 7))}${value.slice(-4)}`;
  if (key === 'email') {
    const [name, domain] = value.split('@');
    return `${name ? `${name.slice(0, 1)}***` : '***'}@${domain ?? ''}`;
  }
  if (key === 'name') return `${value.slice(0, 1)}${'*'.repeat(Math.max(1, value.length - 1))}`;
  return value.length > 4 ? `${value.slice(0, 4)}****` : '****';
}

function hasHeader(header: string, key: RuleKey): boolean {
  const normalized = header.trim().toLowerCase();
  return headerAliases[key].some((alias) => normalized.includes(alias.toLowerCase()));
}

function isValidChineseName(value: string): boolean {
  const text = value.trim();
  if (nonPiiWords.has(text.toLowerCase()) || !/^[\u4e00-\u9fff]{2,5}$/.test(text)) return false;
  const hasCompound = compoundSurnames.some((surname) => text.startsWith(surname));
  return hasCompound || commonSurnames.has(text[0]);
}

function shouldAcceptEntity(entity: ModelEntity): boolean {
  const text = entity.text.trim();
  const threshold = confidenceThresholds[entity.label] ?? confidenceThresholds.DEFAULT;
  if (entity.confidence < threshold || text.length < 2 || text.length > 50) return false;
  if (/^[\s\p{P}]+$/u.test(text) || nonPiiWords.has(text.toLowerCase())) return false;
  return (text.match(/\d/g)?.length ?? 0) / text.length <= 0.3;
}

function maskWithPattern(value: string, key: RuleKey, mode: MaskMode): string {
  const text = value.trim();
  if (!text) return value;

  if (key === 'phone') {
    const digits = text.replace(/\D/g, '');
    if (/^\+?\d{11}$/.test(text.replace(/\s+/g, '')) || /^[1-9]\d{10}$/.test(digits)) {
      return maskValue(text, key, mode);
    }
  }

  if (key === 'idCard') {
    const digits = text.replace(/\s+/g, '');
    if (/^\d{15,18}[\dXx]?$/.test(digits)) {
      return maskValue(digits, key, mode);
    }
  }

  if (key === 'email' && /@/.test(text)) {
    return maskValue(text, key, mode);
  }

  if (
    key === 'address' &&
    /[\u4e00-\u9fff]/.test(text) &&
    /(?:省|市|区|县|路|街|号|镇|乡|村|道|湾|城|园|大厦|中心|广场)/.test(text)
  ) {
    return maskValue(text, key, mode);
  }

  if (
    key === 'company' &&
    /[\u4e00-\u9fff]/.test(text) &&
    /(?:有限公司|股份有限公司|有限责任公司|集团|科技|网络|信息|技术|文化|传媒|研究院|中心|事务所|医院|银行|学院|公司)/.test(text)
  ) {
    return maskValue(text, key, mode);
  }

  const pattern = patterns[key];
  if (!pattern) return isValidChineseName(value) ? maskValue(value, key, mode) : value;
  return value.replace(pattern, (match) => maskValue(match, key, mode));
}

function applyRules(
  value: string,
  rules: DesensitizationRule[],
  mode: MaskMode,
  allowSemantic: boolean
): string {
  return rules.reduce((result, rule) => {
    if (!rule.enabled || (!allowSemantic && (rule.key === 'name' || rule.key === 'company')))
      return result;
    return maskWithPattern(result, rule.key, mode);
  }, value);
}

function modelLabelToRule(label: string): RuleKey | null {
  const normalized = label.toLowerCase();
  if (normalized.includes('name')) return 'name';
  if (
    normalized.includes('address') ||
    normalized.includes('city') ||
    normalized.includes('street')
  )
    return 'address';
  if (normalized.includes('company') || normalized.includes('organization')) return 'company';
  if (normalized.includes('phone')) return 'phone';
  if (normalized.includes('email')) return 'email';
  if (normalized.includes('national_id') || normalized.includes('ssn')) return 'idCard';
  return null;
}

async function applyModelRules(
  value: string,
  rules: DesensitizationRule[],
  mode: MaskMode
): Promise<string> {
  const semanticRules = rules.filter(
    (rule) => rule.enabled && ['name', 'address', 'company'].includes(rule.key)
  );
  if (!semanticRules.length) return value;
  const regexSpans: ModelEntity[] = [];
  rules
    .filter((rule) => rule.enabled && patterns[rule.key])
    .forEach((rule) => {
      const pattern = patterns[rule.key]!;
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(value))) {
        regexSpans.push({
          text: match[0],
          label: rule.key,
          confidence: 1,
          start: match.index,
          end: match.index + match[0].length,
        });
        if (!pattern.global) break;
      }
    });
  if (regexSpans.length) return value;
  const entities = filterModelEntities(await scanText(value), regexSpans);
  return entities
    .map((entity) => ({ entity, key: modelLabelToRule(entity.label) }))
    .filter(({ key }) => key && semanticRules.some((rule) => rule.key === key))
    .sort((left, right) => right.entity.start - left.entity.start)
    .reduce(
      (result, { entity, key }) =>
        result.slice(0, entity.start) +
        maskValue(entity.text, key!, mode) +
        result.slice(entity.end),
      value
    );
}

export function maskText(value: string, rules: DesensitizationRule[], mode: MaskMode): string {
  return applyRules(value, rules, mode, false);
}

export function filterModelEntities(
  entities: ModelEntity[],
  regexSpans: ModelEntity[]
): ModelEntity[] {
  return entities.filter((entity) => {
    if (!shouldAcceptEntity(entity)) return false;
    return !regexSpans.some((span) => entity.start < span.end && entity.end > span.start);
  });
}

export async function verifyModelHash(url: string, expectedHash: string): Promise<boolean> {
  if (!expectedHash || !window.crypto?.subtle) return false;
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) return false;
  const digest = await window.crypto.subtle.digest('SHA-256', await response.arrayBuffer());
  const actual = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  return actual === expectedHash.toLowerCase();
}

export async function detectModelState(): Promise<ModelStatus> {
  try {
    const resourceResponses = await Promise.all(
      [MODEL_PATH, TOKENIZER_PATH, CONFIG_PATH, VOCAB_PATH, SPECIAL_TOKENS_PATH].map((path) =>
        fetch(path, { method: 'HEAD', cache: 'no-store' })
      )
    );
    if (resourceResponses.some((response) => !response.ok)) {
      return { state: 'MODEL_UNAVAILABLE', reason: '模型文件缺失', fallbackActive: true };
    }
    const hashesValid = await Promise.all([
      verifyModelHash(MODEL_PATH, EXPECTED_MODEL_SHA256),
      verifyModelHash(TOKENIZER_PATH, EXPECTED_TOKENIZER_SHA256),
      verifyModelHash(CONFIG_PATH, EXPECTED_CONFIG_SHA256),
    ]);
    if (hashesValid.some((valid) => !valid)) {
      return {
        state: 'MODEL_UNAVAILABLE',
        reason: '模型关联文件校验失败',
        fallbackActive: true,
      };
    }
    try {
      await initializeModelScanner();
    } catch (error) {
      return {
        state: 'MODEL_DEGRADED',
        reason: `模型加载失败，已降级至规则引擎：${error instanceof Error ? error.message : '未知错误'}`,
        fallbackActive: true,
      };
    }
    return {
      state: 'MODEL_READY',
      reason: '智能扫描已启用，正则与 MiniLM 混合扫描',
      fallbackActive: false,
    };
  } catch {
    return { state: 'MODEL_UNAVAILABLE', reason: '模型资源不可访问', fallbackActive: true };
  }
}

export function getModelStatus(): ModelStatus {
  return {
    state: 'MODEL_UNAVAILABLE',
    reason: '未安装模型，当前使用本地规则引擎',
    fallbackActive: true,
  };
}

export async function desensitizeFile(
  file: File,
  rules: DesensitizationRule[],
  mode: MaskMode
): Promise<Blob> {
  const workbook = await readWorkbookFromBlob(file, { cellDates: true });
  for (const sheetName of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], {
      header: 1,
      defval: '',
    });
    const headers = (rows[0] ?? []).map((header) => String(header));
    const output: unknown[][] = [];
    for (const row of rows) {
      const outputRow: unknown[] = [];
      for (const [columnIndex, cell] of row.entries()) {
        const header = headers[columnIndex] ?? '';
        const columnRule = rules.find(
          (rule) => rule.enabled && header && hasHeader(header, rule.key)
        );

        if (typeof cell === 'number' && columnRule) {
          outputRow.push(maskWithPattern(String(cell), columnRule.key, mode));
          continue;
        }

        if (typeof cell !== 'string') {
          outputRow.push(cell);
          continue;
        }

        const regexResult = columnRule
          ? maskWithPattern(cell, columnRule.key, mode)
          : applyRules(cell, rules, mode, false);
        outputRow.push(columnRule ? regexResult : await applyModelRules(regexResult, rules, mode));
      }
      output.push(outputRow);
    }
    workbook.Sheets[sheetName] = XLSX.utils.aoa_to_sheet(output);
  }
  return new Blob([XLSX.write(workbook, { bookType: 'xlsx', type: 'array' })], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

export async function verifyDesensitizedFile(
  blob: Blob,
  rules: DesensitizationRule[]
): Promise<VerificationReport> {
  const workbook = await readWorkbookFromBlob(blob);
  const leaks: VerificationReport['leaks'] = [];
  workbook.SheetNames.forEach((sheetName) => {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], {
      header: 1,
      defval: '',
    });
    rows.forEach((row, rowIndex) =>
      row.forEach((cell, columnIndex) => {
        if (typeof cell !== 'string') return;
        rules
          .filter((rule) => rule.enabled && patterns[rule.key])
          .forEach((rule) => {
            patterns[rule.key]?.lastIndex && (patterns[rule.key]!.lastIndex = 0);
            if (patterns[rule.key]?.test(cell))
              leaks.push({
                sheet: sheetName,
                row: rowIndex + 1,
                column: XLSX.utils.encode_col(columnIndex),
                type: rule.key,
              });
          });
      })
    );
  });
  return { clean: leaks.length === 0, totalLeaks: leaks.length, leaks: leaks.slice(0, 100) };
}

export async function readPreview(source: Blob, maxRows = 12): Promise<PreviewTable> {
  const workbook = await readWorkbookFromBlob(source);
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  const values = XLSX.utils.sheet_to_json<unknown[]>(firstSheet, {
    header: 1,
    defval: '',
  });
  const normalized = values
    .slice(0, maxRows + 1)
    .map((row) => row.map((cell) => String(cell ?? '')));
  return {
    headers: normalized[0] ?? [],
    rows: normalized.slice(1),
  };
}
