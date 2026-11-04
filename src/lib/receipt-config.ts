/**
 * Настройка квитанции из строк: заготовки по виду (плитке), перевод старой квитанции (тарифы) в строки
 * и проверка того, что пришло из окна. Общий для окна (клиент) и сохранения (сервер).
 */
import { activeTariff } from './calc/engine.ts';
import { billKeyOf } from './calc/lines.ts';
import type { QtySrc, ReceiptConfig, ReceiptLine, Service, ServiceKind, Tenant } from './calc/types.ts';

/** Единицы строки (кроме «₽» — строка-сумма). */
export const UNITS = ['кВт·ч', 'м³', 'Гкал', 'м²', 'шт.', 'ед.'];

export const blankLine = (id = '', o: Partial<ReceiptLine> = {}): ReceiptLine =>
  ({ id, sign: 1, name: '', unit: '₽', q: { src: 'month', read: 'diff' }, t: { mode: 'set' }, ...o });
export const blankPay = (): ReceiptConfig['pay'] => ({ mode: 'shares', vacant: true, rest: 'none', base: 'qty', off: [] });

/** Плитка подставляет первую строку — только самое частое, остальное меняется в меню. */
type Preset = { unit: string; q: QtySrc; t?: 'set' | 'month' | 'sum'; equal?: boolean; owner?: boolean };
const PRESET: Record<string, Preset> = {
  el: { unit: 'кВт·ч', q: 'each', t: 'set' },
  cw: { unit: 'м³', q: 'each', t: 'sum' },
  hw: { unit: 'м³', q: 'each', t: 'sum' },
  dr: { unit: 'м³', q: 'sum', t: 'set' },
  gas: { unit: 'м³', q: 'each', t: 'sum' },
  trash: { unit: '₽', q: 'month', equal: true },
  dom: { unit: '₽', q: 'month', equal: true },
  net: { unit: '₽', q: 'month', equal: true },
  // Не перевыставляется: платите вы.
  kr: { unit: '₽', q: 'month', owner: true },
  fine: { unit: '₽', q: 'month', owner: true },
  ins: { unit: '₽', q: 'month', owner: true },
};

/** Первая строка и «кто платит» по виду квитанции. sumSources — квитанции со счётчиками для «суммы счётчиков». */
export function applyPreset(cfg: ReceiptConfig, category: string, tenants: Tenant[], sumSources: string[]): ReceiptConfig {
  const P = PRESET[category] ?? { unit: '₽', q: 'month' };
  const l = blankLine(cfg.lines[0]?.id ?? '', { unit: P.unit, q: { src: P.q, read: 'diff' }, t: { mode: P.t ?? 'set' }, meters: cfg.lines[0]?.meters });
  if (P.q === 'sum') l.q.srcs = sumSources;
  return { ...cfg, lines: [l], pay: { ...cfg.pay, mode: P.equal ? 'equal' : 'shares', off: P.owner ? tenants.map((t) => t.id) : [] } };
}

export const newConfig = (category: string, tenants: Tenant[], sumSources: string[]): ReceiptConfig =>
  applyPreset({ lines: [blankLine()], pay: blankPay(), coef: 1 }, category, tenants, sumSources);

/**
 * Старая квитанция (способ деления + тариф) → строки. Ключи хранения те же, что у старой квитанции:
 * первая строка '' (показания и сумма на помещение остаются на месте), день/ночь — 'day' / 'night'.
 * null — перевести нельзя (например, разные фиксированные суммы у арендаторов).
 */
export function fromLegacy(s: Service, tenants: Tenant[], month: string): ReceiptConfig | null {
  const act = tenants.map((t) => [t, activeTariff(s, t.id, month)] as const).filter(([, x]) => x);
  const tr = act[0]?.[1] ?? [...s.tariffs].sort((a, b) => b.from.localeCompare(a.from))[0];
  if (!tr) return null;
  const payers = new Set(act.filter(([, x]) => x!.logic === tr.logic).map(([t]) => t.id));
  const pay = { ...blankPay(), off: act.length ? tenants.filter((t) => !payers.has(t.id)).map((t) => t.id) : [] };
  const unit = s.unit && s.unit !== '₽' ? s.unit : 'ед.';
  let lines: ReceiptLine[] = [blankLine()];
  switch (tr.logic) {
    case 'share': lines = [blankLine()]; break;
    case 'equal': lines = [blankLine()]; pay.mode = 'equal'; pay.vacant = false; break;
    case 'whole': lines = [blankLine()]; pay.off = tenants.map((t) => t.id); break;
    case 'fixed': {
      const prices = new Set(act.filter(([, x]) => x!.logic === 'fixed').map(([, x]) => x!.price ?? 0));
      if (prices.size > 1) return null;
      lines = [blankLine('', { q: { src: 'const', v: (tr.price ?? 0) * Math.max(1, payers.size) } })];
      pay.mode = 'equal'; pay.vacant = false;
      break;
    }
    case 'split': lines = [blankLine('', { unit, q: { src: 'each', read: 'direct' }, t: { mode: 'sum' } })]; break;
    case 'meter': lines = [blankLine('', { unit, q: { src: 'each', read: 'diff' }, t: { mode: 'set', p: tr.price } })]; break;
    case 'meterRest':
      lines = [blankLine('', { unit, q: { src: 'each', read: 'diff' }, t: { mode: 'set', p: tr.price } })];
      if (tr.norm !== undefined && tr.normPrice !== undefined) {
        lines[0].name = unit === 'м³' ? 'вода' : 'расход';
        lines.push(blankLine('L2', { name: tr.extraName || 'подогрев', unit: 'Гкал', q: { src: 'norm', k: tr.norm, ref: '' }, t: { mode: 'set', p: tr.normPrice } }));
      }
      pay.rest = 'shares'; pay.base = 'total';
      break;
    case 'dn':
      lines = [
        blankLine('day', { name: 'день', unit, q: { src: 'each', read: 'diff' }, t: { mode: 'set', p: tr.price } }),
        blankLine('night', { name: 'ночь', unit, q: { src: 'each', read: 'diff' }, t: { mode: 'set', p: tr.price2 } }),
      ];
      break;
    case 'derived':
    case 'norm': {
      const p = tr.price === undefined ? undefined : tr.logic === 'norm' ? tr.price * (tr.norm ?? 1) : tr.price;
      lines = [blankLine('', { unit: 'м³', q: { src: 'sum', srcs: tr.sources ?? [] }, t: { mode: 'set', p } })];
      break;
    }
  }
  const cfg: ReceiptConfig = { lines, pay, coef: 1 };
  return { ...cfg, billKey: billKeyOf(cfg) };
}

/** Вид счёта для старых разделов (группировка, «только арендодатель»). */
export function kindOfConfig(cfg: ReceiptConfig, tenantIds: string[]): ServiceKind {
  if (tenantIds.length && tenantIds.every((t) => cfg.pay.off.includes(t))) return 'owner';
  return cfg.lines.some((l) => l.q.src === 'each' || l.q.src === 'sum') ? 'indiv' : 'common';
}

const finite = (v: unknown, min = 0) => (typeof v === 'number' && Number.isFinite(v) && v >= min ? v : undefined);
const oneOf = <T extends string>(v: unknown, xs: readonly T[], d: T): T => (xs.includes(v as T) ? (v as T) : d);

/** Проверка настройки из окна: только известные поля и значения, ссылки — на свои строки, квитанции и арендаторов. */
export function sanitizeConfig(raw: unknown, tenantIds: string[], sourceIds: string[]): ReceiptConfig | null {
  const r = raw as Partial<ReceiptConfig> | null;
  if (!r || !Array.isArray(r.lines) || !r.lines.length || r.lines.length > 12) return null;
  const ids = new Set<string>();
  const lines: ReceiptLine[] = [];
  for (const x of r.lines as Partial<ReceiptLine>[]) {
    const id = typeof x?.id === 'string' && /^(|day|night|L\d{1,3})$/.test(x.id) && !ids.has(x.id) ? x.id : null;
    if (id === null) return null;
    ids.add(id);
    const unit = x.unit === '₽' || UNITS.includes(String(x.unit)) ? String(x.unit) : '₽';
    const q: Partial<ReceiptLine['q']> = x.q ?? {};
    const meters: Record<string, string> = {};
    for (const [k, v] of Object.entries(x.meters ?? {})) {
      if ((k === 'common' || tenantIds.includes(k)) && typeof v === 'string' && v.trim()) meters[k] = v.trim().slice(0, 20);
    }
    lines.push({
      id, sign: x.sign === -1 ? -1 : 1, name: String(x.name ?? '').trim().slice(0, 30), unit,
      q: {
        src: oneOf(q.src, ['const', 'month', 'each', 'norm', 'sum'] as const, 'month'),
        v: finite(q.v), read: oneOf(q.read, ['diff', 'direct'] as const, 'diff'), k: finite(q.k),
        ref: typeof q.ref === 'string' ? q.ref : undefined,
        srcs: Array.isArray(q.srcs) ? [...new Set(q.srcs.filter((s) => sourceIds.includes(s)))] : undefined,
      },
      t: { mode: oneOf(x.t?.mode, ['set', 'month', 'sum'] as const, 'set'), p: finite(x.t?.p), common: x.t?.common === true },
      meters,
    });
  }
  for (const l of lines) {
    if (l.q.src === 'norm' && (!ids.has(l.q.ref ?? '\0') || l.q.ref === l.id)) l.q.ref = lines.find((y) => y !== l)?.id;
    if (l.q.src !== 'norm') delete l.q.ref;
    if (l.q.src !== 'sum') delete l.q.srcs;
    if (l.q.src !== 'const') delete l.q.v;
    if (l.q.src !== 'norm') delete l.q.k;
    if (l.unit === '₽' || l.t.mode !== 'set') delete l.t.p;
    if (l.unit === '₽' || l.t.mode !== 'sum' || l.q.src === 'const' || l.q.src === 'month') l.t.common = false;
  }
  const p = (r.pay ?? {}) as Partial<ReceiptConfig['pay']>;
  const pay: ReceiptConfig['pay'] = {
    mode: oneOf(p.mode, ['shares', 'equal'] as const, 'shares'), vacant: p.vacant !== false,
    rest: oneOf(p.rest, ['none', 'shares', 'equal', 'self'] as const, 'none'), base: oneOf(p.base, ['qty', 'total'] as const, 'qty'),
    baseLine: typeof p.baseLine === 'string' && ids.has(p.baseLine) ? p.baseLine : undefined,
    off: Array.isArray(p.off) ? [...new Set(p.off.filter((t) => tenantIds.includes(t)))] : [],
  };
  if (pay.rest !== 'none' && pay.base === 'qty' && pay.baseLine === undefined) pay.baseLine = lines.find((l) => l.unit !== '₽')?.id;
  const coef = finite(r.coef) ?? 1;
  const cfg: ReceiptConfig = { lines, pay, coef: coef > 0 && coef <= 10 ? coef : 1 };
  return { ...cfg, billKey: billKeyOf(cfg) };
}
