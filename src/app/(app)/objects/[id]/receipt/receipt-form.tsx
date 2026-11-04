'use client';

import { useActionState, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { CalendarDays, ChartColumn, Check, FileText, Lock, Pencil, Percent, Plus, RussianRuble, X } from 'lucide-react';
import { CancelButton } from '../../../modal';
import { Select } from '@/components/select';
import { KindIcon } from '@/components/kind-icon';
import { calcReceipt, coefOf, isRub, lineLabel, nextLineId, tenantSum, type ReceiptEnv } from '@/lib/calc/lines';
import { fmtMoney, fmtPrice, fmtQty } from '@/lib/calc/format';
import type { ReceiptConfig, ReceiptLine, Reading } from '@/lib/calc/types';
import { CATEGORIES, category } from '@/lib/receipts';
import { UNITS, applyPreset, blankLine } from '@/lib/receipt-config';
import { deleteReceipt, saveReceipt, type ReceiptDraft, type ReceiptState } from './actions';

type T = { id: string; name: string; share: number };
/** Другие квитанции объекта: в каких единицах у них счётчики арендаторов и сколько по ним в этом месяце. */
export type OtherReceipt = { id: string; name: string; units: string[]; use: Record<string, Record<string, number | null>> };
/** Месячные значения этой квитанции (для примера расчёта при правке). */
export type MonthData = { values: Record<string, number | undefined>; readings: Record<string, Record<string, Reading | undefined>> };

/** Плитки «Что за квитанция» — самые частые; свой вид — «Своя». */
const TILES = ['uk', 'el', 'cw', 'hw', 'dr', 'heat', 'gas', 'trash', 'kr'];

const toNum = (s: string) => {
  const t = s.replace(/\s/g, '').replace(',', '.');
  const n = Number(t);
  return t !== '' && Number.isFinite(n) ? n : undefined;
};
const showNum = (n: number | undefined) => (n === undefined ? '' : String(n).replace('.', ','));
const pct = (n: number) => fmtQty(Math.round(n * 10) / 10) + '%';

/** Что считаем: сначала три главных, ниже — «Ещё». */
type QKey = 'rub' | 'rubc' | 'each' | 'month' | 'const' | 'sum' | 'norm';
const QOPT: Array<[QKey, string, string]> = [
  ['rub', 'Сумма квитанции', 'пишу каждый месяц из квитанции'],
  ['rubc', 'Фиксированная сумма в месяц', 'одна и та же каждый месяц'],
  ['each', 'Счётчик', 'показания у каждого арендатора'],
  ['month', 'Объём из квитанции', 'кВт·ч, м³, Гкал — пишу каждый месяц'],
  ['const', 'Постоянный объём', 'площадь, шт. — один раз'],
  ['sum', 'Сумма других счётчиков', 'напр. вода хол. + гор.'],
  ['norm', 'Норма × другая строка', 'напр. подогрев 0,06 Гкал × м³'],
];
const QMAIN: QKey[] = ['rub', 'rubc', 'each'];
const QICON: Record<QKey, typeof FileText> = { rub: RussianRuble, rubc: Lock, each: ChartColumn, month: FileText, const: Lock, sum: Plus, norm: Percent };
const qKey = (l: ReceiptLine): QKey => (isRub(l) ? (l.q.src === 'const' ? 'rubc' : 'rub') : l.q.src);
/** Примерные тарифы для «Примера расчёта», пока свой не вписан. */
const PRICE_EX: Record<string, number> = { 'кВт·ч': 6.5, 'м³': 45, 'Гкал': 4628.57, 'м²': 36.4 };
const exU = (j: number) => [120, 80, 60, 40][j % 4];

/** День/ночь: строка «день» и сразу за ней «ночь» — одна строка в окне, тариф двумя окошками. */
const nightOf = (L: ReceiptLine[], l: ReceiptLine) => { const n = L[L.indexOf(l) + 1]; return l.name === 'день' && l.q.src === 'each' && n && n.name === 'ночь' ? n : null; };
const isNightRow = (L: ReceiptLine[], l: ReceiptLine) => { const pr = L[L.indexOf(l) - 1]; return !!pr && nightOf(L, pr) === l; };
/** «Ночь» повторяет за «днём» всё, кроме тарифа и показаний. */
function syncNight(cfg: ReceiptConfig) {
  for (const l of [...cfg.lines]) {
    const n = cfg.lines[cfg.lines.indexOf(l) + 1];
    if (l.name !== 'день' || !n || n.name !== 'ночь') continue;
    if (l.q.src !== 'each') { cfg.lines = cfg.lines.filter((x) => x !== n); l.name = ''; continue; }
    n.unit = l.unit; n.q = { ...n.q, src: 'each', read: l.q.read }; n.t = { ...n.t, mode: l.t.mode, common: l.t.common };
  }
}

export function ReceiptForm(p: {
  objectId: string; objectName: string; month: string; monthText: string; serviceId: string | null; isOwner: boolean;
  init: ReceiptDraft; suppliers: string[]; tenants: T[]; others: OtherReceipt[]; data: MonthData; converted: boolean;
}) {
  const [state, action, pending] = useActionState<ReceiptState, FormData>(saveReceipt.bind(null, p.objectId, p.serviceId, p.month), {});
  const [d, setD] = useState<ReceiptDraft>(p.init);
  const [open, setOpen] = useState<string | null>(null);
  const [suppliers, setSuppliers] = useState(p.suppliers);
  const [nameErr, setNameErr] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [deleting, startDelete] = useTransition();
  const e = state.errors ?? {};
  const up = (fn: (x: ReceiptDraft) => void) => setD((prev) => { const n = structuredClone(prev); fn(n); syncNight(n.cfg); return n; });
  const upLine = (id: string, fn: (l: ReceiptLine, x: ReceiptDraft) => void) => up((x) => { const l = x.cfg.lines.find((y) => y.id === id); if (l) fn(l, x); });
  const L = d.cfg.lines, P = d.cfg.pay, T = p.tenants;
  const sumCandidates = (unit: string) => p.others.filter((o) => o.units.includes(unit));
  const newR = !p.serviceId;

  // Меню у плашки закрывается кликом мимо.
  useEffect(() => {
    if (!open) return;
    const close = (ev: MouseEvent) => { if (!(ev.target as HTMLElement).closest('[data-dd]')) setOpen(null); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  // Плитка: название и первая строка подставляются (строка — только в новой квитанции с одной строкой).
  const pickKind = (id: string) => up((x) => {
    const prev = category(x.category), c = category(id);
    const auto = (v: string) => !v.trim() || v === prev.name || CATEGORIES.some((k) => k.name === v);
    x.category = id;
    if (auto(x.name)) x.name = id ? c.name : '';
    if (!x.supplier.trim() || x.supplier === prev.supplier) x.supplier = c.supplier;
    if (!p.serviceId && x.cfg.lines.filter((l) => !isNightRow(x.cfg.lines, l)).length === 1) {
      const pre = applyPreset(x.cfg, id, T, []);
      pre.lines[0].q.srcs = pre.lines[0].q.src === 'sum' ? sumCandidates(pre.lines[0].unit).map((o) => o.id) : undefined;
      x.cfg = pre;
    }
  });

  // Пример расчёта: в новой квитанции — примерные числа, при правке — числа этого месяца; пустые постоянные — тоже пример.
  const view = useMemo(() => {
    const idx = (tid: string) => T.findIndex((t) => t.id === tid);
    const pcfg: ReceiptConfig = {
      ...d.cfg,
      lines: d.cfg.lines.map((l) => ({ ...l, q: { ...l.q, v: l.q.v ?? (isRub(l) ? (l.sign < 0 ? 300 : 2000) : 45), k: l.q.k ?? 0.06 }, t: { ...l.t, p: l.t.p ?? PRICE_EX[l.unit] ?? 10 } })),
    };
    const exCommon = T.reduce((a, _, j) => a + exU(j), 0) + 20;
    const env: ReceiptEnv = {
      tenants: T,
      value: (k) => {
        if (!newR) return p.data.values[k];
        if (k === 'qty') return 10;
        if (k === 'total') return 5000;
        const [lid, f] = k.split(':'), l = d.cfg.lines.find((y) => y.id === lid);
        return ({ v: l && isRub(l) ? 4200 : 120, tp: 6.5, money: 1200, camt: exCommon, cprev: 5000, ccur: 5000 + exCommon } as Record<string, number>)[f];
      },
      reading: (tid, l) => {
        if (!newR) return p.data.readings[tid]?.[l.id];
        const j = idx(tid), pr = 1000 + 500 * j;
        return { prev: pr, cur: pr + exU(j), usage: exU(j) };
      },
      source: (id, tid, unit) => {
        const o = p.others.find((x) => x.id === id);
        if (!o || !o.units.includes(unit)) return undefined;
        return newR ? exU(idx(tid)) : o.use[unit]?.[tid] ?? null;
      },
      sourceName: (id) => p.others.find((x) => x.id === id)?.name ?? '?',
    };
    return { C: calcReceipt(pcfg, env), pcfg };
  }, [d.cfg, T, newR, p.data, p.others]);

  const submit = (ev: React.FormEvent) => {
    if (!d.name.trim() && !(d.category && category(d.category).name)) { ev.preventDefault(); setNameErr(true); }
  };

  return (
    <form action={action} onSubmit={submit} noValidate className="flex flex-col gap-1">
      <input type="hidden" name="data" value={JSON.stringify(d)} />
      <h1 className="text-[20px] font-bold">{p.serviceId ? 'Изменить квитанцию' : 'Новая квитанция'}</h1>
      <div className="hint text-[13px]">{p.objectName} · {T.length ? T.map((t) => `${t.name} ${pct(t.share)}`).join(', ') : 'пользуется собственник'}</div>
      {e.form && <p role="alert" className="mt-2 rounded-lg bg-bad-soft px-3 py-2 text-bad">{e.form}</p>}
      {p.converted && (
        <p className="mt-3 rounded-lg border border-line bg-[#f6f8fb] px-3 py-2 text-[13px] text-ink-2">
          Квитанция заведена по-старому — ниже она уже разложена по строкам. Проверьте и сохраните: суммы и показания этого месяца останутся на месте.
        </p>
      )}

      <Step n={3} title="Привязываем услугу" sub="что за квитанция и как поставщик её считает" />
      <Box title="Что за квитанция">
        <div role="radiogroup" aria-label="Вид квитанции" className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-6">
          {[...TILES, ...(d.category && !TILES.includes(d.category) ? [d.category] : [])].map((id) => category(id)).map((c) => (
            <Tile key={c.id} on={d.category === c.id} onClick={() => pickKind(c.id)} icon={<KindIcon name={c.icon} size={24} />} label={c.name} />
          ))}
          <Tile on={d.category === ''} dashed onClick={() => pickKind('')} icon={<Plus size={24} strokeWidth={1.6} />} label="Своя" />
        </div>
      </Box>

      <Box title="Квитанция">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="label"><span>Поставщик</span>
            <Select value={d.supplier} onChange={(v) => up((x) => { x.supplier = v; })}
              options={[{ value: '', label: 'Не указан' }, ...[...new Set([d.supplier, ...suppliers].filter(Boolean))].map((x) => ({ value: x, label: x }))]}
              create={{ placeholder: 'свой вариант…', onCreate: (label) => { if (!suppliers.includes(label)) setSuppliers([...suppliers, label]); return label; } }} />
          </div>
          <label className="label"><span>Название в счёте арендатору</span>
            <span className={`field ${nameErr || e.name ? 'field-err bg-warn-soft' : ''}`}>
              <input value={d.name} placeholder={nameErr ? 'Впишите название' : d.category ? category(d.category).name : 'Например, «Электричество»'}
                onChange={(x) => { setNameErr(false); up((y) => { y.name = x.target.value; }); }} />
            </span>
            {e.name && <span className="text-[12px] text-[#b4362b]">{e.name}</span>}
          </label>
        </div>
      </Box>

      <Box title="Как считаем" note="· выберите в меню">
        <div className="flex flex-col">
          {L.map((l, i) => (isNightRow(L, l) ? null : (
            <LineRow key={l.id || '_'} l={l} i={i} L={L} open={open} setOpen={setOpen} upLine={upLine} up={up} candidates={sumCandidates} kind={d.category} />
          )))}
        </div>
        <AddLines L={L} up={up} />
        <Switches L={L} up={up} />
        {L[0] && L[0].q.src === 'each' && !isRub(L[0]) && <MeterStrip l={L[0]} L={L} off={P.off} tenants={T} upLine={upLine} />}
      </Box>

      <Step n={4} title="Распределяем затраты" sub="кто и как платит" />
      <PayRow cfg={d.cfg} tenants={T} up={up} />

      <Formula C={view.C} pcfg={view.pcfg} cfg={d.cfg} tenants={T} newR={newR} />

      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        {p.serviceId && (
          <span className="mr-auto flex items-center gap-2">
            {confirmDel ? (
              <>
                <span className="text-[13px] text-muted">Удалить квитанцию за все месяцы?</span>
                <button type="button" className="btn border-bad/40 text-bad hover:bg-bad-soft" disabled={deleting}
                  onClick={() => startDelete(() => deleteReceipt(p.objectId, p.serviceId!, p.month))}>{deleting ? 'Удаляем…' : 'Да, удалить'}</button>
                <button type="button" className="btn" onClick={() => setConfirmDel(false)}>Нет</button>
              </>
            ) : <button type="button" className="btn text-bad hover:bg-bad-soft" onClick={() => setConfirmDel(true)}>Удалить</button>}
          </span>
        )}
        <CancelButton href={`/objects/${p.objectId}?m=${p.month}`} />
        <button className="btn btn-primary" disabled={pending}>{pending ? 'Сохраняем…' : p.serviceId ? 'Сохранить' : 'Добавить'}</button>
      </div>
    </form>
  );
}

function Step({ n, title, sub }: { n: number; title: string; sub: string }) {
  return (
    <div className="mt-5 flex items-center gap-2.5">
      <span className="flex size-7 flex-none items-center justify-center rounded-full bg-cta font-bold text-white">{n}</span>
      <div><b className="text-[15px]">{title}</b><div className="text-[13px] text-muted">{sub}</div></div>
    </div>
  );
}

function Box({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="mt-2.5 rounded-[10px] border border-line">
      <div className="flex items-center gap-2 rounded-t-[10px] border-b border-line bg-[#f7f8f9] px-3.5 py-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-[0.5px] text-muted">{title}</span>
        {note && <span className="text-[13px] text-muted">{note}</span>}
      </div>
      <div className="p-3.5">{children}</div>
    </section>
  );
}

function Tile({ on, dashed, onClick, icon, label }: { on: boolean; dashed?: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button type="button" role="radio" aria-checked={on} onClick={onClick}
      className={`flex flex-col items-center gap-[7px] rounded-[10px] border px-1.5 pb-2.5 pt-3 text-center text-[13px] leading-tight ${on
        ? 'border-cta bg-cta-soft font-semibold text-cta-ink' : `bg-white hover:border-accent ${dashed ? 'border-dashed border-line-strong text-muted' : 'border-line text-ink [&_svg]:text-accent'}`}`}>
      {icon}{label}
    </button>
  );
}

/** Поле «один раз»: вписали — закрепилось (уход из поля, Enter или ✓); ✎ — открыть снова. */
function OnceField({ value, onChange, unit, pre, text, placeholder = '0,00', optional, label }: {
  value: number | string | undefined; onChange: (v: string) => void; unit?: string; pre?: string; text?: boolean; placeholder?: string; optional?: boolean; label: string;
}) {
  const empty = value === undefined || value === '';
  const [edit, setEdit] = useState(empty);
  const [txt, setTxt] = useState(typeof value === 'number' ? showNum(value) : value ?? '');
  const box = useRef<HTMLSpanElement>(null);
  const editing = edit || empty;
  const lock = () => { if (txt.trim() !== '') setEdit(false); };
  const shown = typeof value === 'number' ? (unit === '₽' ? fmtMoney(value) : fmtQty(value)) : value;
  return (
    <span ref={box} className={`flex h-8 min-w-0 items-center overflow-hidden rounded-[7px] border ${empty && !optional ? 'border-[#f0dcb5] bg-warn-soft' : editing ? 'border-accent bg-white' : 'border-line bg-[#f7f8f9]'}`}
      onBlur={(ev) => { if (!box.current?.contains(ev.relatedTarget as Node)) lock(); }}>
      {pre && <span className="flex-none pl-2 text-[12px] text-[#5d6d7e]">{pre}</span>}
      {editing ? (
        <input aria-label={label} inputMode={text ? 'text' : 'decimal'} maxLength={text ? 20 : undefined} value={txt} placeholder={placeholder}
          className={`h-full min-w-0 flex-1 border-0 bg-transparent py-1 pl-2 pr-1.5 outline-none ${text ? 'text-left' : 'text-right'}`}
          onChange={(x) => { setTxt(x.target.value); onChange(x.target.value); }}
          onKeyDown={(x) => { if (x.key === 'Enter') { x.preventDefault(); lock(); } }} />
      ) : <span className={`min-w-0 flex-1 truncate pl-2 pr-1 font-semibold ${text ? 'text-left' : 'text-right'}`}>{text ? `№ ${shown}` : shown}</span>}
      {unit && <span className="flex-none pl-0.5 pr-2 text-[12px] text-muted">{unit}</span>}
      {editing ? (
        <button type="button" title="Сохранить" aria-label="Сохранить" onMouseDown={(x) => { x.preventDefault(); lock(); }}
          className="grid h-full w-7 flex-none place-items-center border-l border-[#cfe8d9] bg-ok-soft text-ok"><Check size={15} strokeWidth={2} /></button>
      ) : (
        <button type="button" title="Изменить" aria-label="Изменить" onClick={() => setEdit(true)}
          className="grid h-full w-7 flex-none place-items-center border-l border-[#d6e4f5] bg-[#eaf2fb] text-[#3b78c4]"><Pencil size={14} strokeWidth={2} /></button>
      )}
    </span>
  );
}

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex min-w-0 flex-1 flex-col justify-center gap-[3px] px-2.5 py-1.5">
    <small className="truncate text-[12px] text-[#5d6d7e]">{label}</small>{children}
  </div>
);
const Monthly = ({ what, label = 'Каждый месяц вписываем:' }: { what: string; label?: string }) => (
  <Field label={label}>
    <span title="Вписываете каждый месяц в рамке квитанции на странице объекта"
      className="flex h-8 min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-[7px] border border-dashed border-[#c3ccd5] bg-[#f7f8f9] px-2 text-[12px] text-muted">
      <CalendarDays size={16} className="flex-none text-[#3b78c4]" /><span className="truncate">{what}</span>
    </span>
  </Field>
);

function DdItem({ on, title, sub, onClick }: { on: boolean; title: string; sub?: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left hover:bg-[#f7f8f9]">
      <span className="flex-1"><b className={`block text-[14px] ${on ? 'font-semibold' : 'font-medium'}`}>{title}</b>{sub && <small className="block text-[12px] text-muted">{sub}</small>}</span>
      <i className="w-3.5 not-italic font-bold text-cta-ink">{on ? '✓' : ''}</i>
    </button>
  );
}

function Chip({ on, disabled, onClick, children, dashed }: { on: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode; dashed?: boolean }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} aria-pressed={on}
      className={`inline-flex items-center gap-1.5 rounded-lg border bg-white px-2.5 py-[5px] text-[12px] font-medium disabled:cursor-not-allowed disabled:opacity-45 ${dashed ? 'border-dashed' : ''} ${on ? 'border-accent text-ink shadow-[inset_0_0_0_1px_var(--color-accent)]' : 'border-line text-muted'}`}>
      {!dashed && <span className={`flex size-3.5 flex-none items-center justify-center rounded border-[1.5px] ${on ? 'border-accent bg-accent text-white' : 'border-[#b6bfc9] bg-white'}`}>{on && <Check size={10} strokeWidth={3} />}</span>}
      {children}
    </button>
  );
}

function Seg<V extends string>({ items, value, onPick, disabled }: { items: Array<[V, string]>; value: V | undefined; onPick: (v: V) => void; disabled?: boolean }) {
  return (
    <span className={`flex rounded-lg border border-line bg-[#f7f8f9] p-0.5 ${disabled ? 'opacity-45' : ''}`}>
      {items.map(([v, t]) => (
        <button key={v} type="button" disabled={disabled} onClick={() => onPick(v)}
          className={`whitespace-nowrap rounded-md px-2.5 py-1.5 text-[13px] disabled:cursor-default ${!disabled && v === value ? 'bg-white font-semibold text-ink shadow-[0_1px_2px_rgba(44,62,80,.15)]' : 'text-muted'}`}>{t}</button>
      ))}
    </span>
  );
}

type Up = (fn: (x: ReceiptDraft) => void) => void;
type UpLine = (id: string, fn: (l: ReceiptLine, x: ReceiptDraft) => void) => void;

/** Строка квитанции: [что ▾ | поле]  или  [что ▾ | ед. изм. ▾] × [объём / тариф]. */
function LineRow({ l, i, L, open, setOpen, upLine, up, candidates, kind }: {
  l: ReceiptLine; i: number; L: ReceiptLine[]; open: string | null; setOpen: (v: string | null) => void;
  upLine: UpLine; up: Up; candidates: (unit: string) => OtherReceipt[]; kind: string;
}) {
  const k = qKey(l), qo = QOPT.find((x) => x[0] === k)!, Icon = QICON[k], night = nightOf(L, l);
  const qOpen = open === `${l.id}:q`, uOpen = open === `${l.id}:u`;
  const multi = L.filter((x) => !isNightRow(L, x)).length > 1;
  const refL = l.q.src === 'norm' ? L.find((x) => x.id === l.q.ref) : undefined;
  const setNum = (fn: (l: ReceiptLine, n: number | undefined) => void, id = l.id) => (v: string) => upLine(id, (y) => fn(y, toNum(v)));

  const pickQ = (v: QKey) => upLine(l.id, (y, x) => {
    if (v === 'rub' || v === 'rubc') { y.unit = '₽'; y.q.src = v === 'rub' ? 'month' : 'const'; y.t.common = false; setOpen(null); return; }
    if (isRub(y)) { const pu = applyPreset(x.cfg, kind, [], []).lines[0].unit; y.unit = pu !== '₽' ? pu : 'кВт·ч'; y.t.mode = 'set'; }
    y.q.src = v;
    if (v === 'norm' && !x.cfg.lines.some((z) => z.id === y.q.ref && z !== y)) y.q.ref = x.cfg.lines.find((z) => z !== y)?.id;
    if (v === 'sum' && !y.q.srcs?.length) y.q.srcs = candidates(y.unit).map((o) => o.id);
    if (v === 'const' || v === 'month') y.t.common = false;
    if (v !== 'sum' && v !== 'norm') setOpen(null);
  });

  const plate = (
    <button type="button" onClick={() => setOpen(qOpen ? null : `${l.id}:q`)}
      className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-l-[10px] px-3 py-2 text-left">
      <Icon size={24} strokeWidth={1.6} className="flex-none text-cta" />
      <span className="min-w-0 flex-1"><b className="block truncate text-[14px]">{qo[1]}</b><small className="block truncate text-[12px] text-muted">{qo[2]}</small></span>
      <i className="not-italic text-[12px] text-muted">▾</i>
    </button>
  );
  const menu = qOpen && (
    <div className="absolute left-0 top-[calc(100%+6px)] z-20 w-[330px] min-w-full max-w-[90vw] rounded-lg border border-line bg-white p-1 shadow-[0_6px_18px_rgba(44,62,80,.12)]">
      {QOPT.filter(([v]) => QMAIN.includes(v)).map(([v, t, s]) => <DdItem key={v} on={v === k} title={t} sub={s} onClick={() => pickQ(v)} />)}
      <div className="mt-1 border-t border-line px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.5px] text-muted">Ещё</div>
      {QOPT.filter(([v]) => !QMAIN.includes(v) && (v !== 'norm' || L.length > 1)).map(([v, t, s]) => <DdItem key={v} on={v === k} title={t} sub={s} onClick={() => pickQ(v)} />)}
      {l.q.src === 'norm' && (
        <div className="mt-1 flex flex-col gap-1.5 border-t border-line px-2.5 py-2 text-[12px] text-muted"><span>Умножаем на</span>
          <span className="flex flex-wrap gap-1.5">{L.filter((x) => x !== l).map((x) => (
            <Chip key={x.id} on={x.id === l.q.ref} onClick={() => upLine(l.id, (y) => { y.q.ref = x.id; })}>{`${x.name || 'строка ' + (L.indexOf(x) + 1)}, ${x.unit}`}</Chip>
          ))}</span></div>
      )}
      {l.q.src === 'sum' && (
        <div className="mt-1 flex flex-col gap-1.5 border-t border-line px-2.5 py-2 text-[12px] text-muted"><span>Складываем</span>
          <span className="flex flex-wrap gap-1.5">{candidates(l.unit).length ? candidates(l.unit).map((o) => (
            <Chip key={o.id} on={!!l.q.srcs?.includes(o.id)} onClick={() => upLine(l.id, (y) => {
              const s = y.q.srcs ?? []; y.q.srcs = s.includes(o.id) ? s.filter((z) => z !== o.id) : [...s, o.id];
            })}>{o.name}</Chip>
          )) : <span>нет квитанций со счётчиками в {l.unit}</span>}</span></div>
      )}
    </div>
  );
  const group = (right: React.ReactNode, wide = false) => (
    <div data-dd className="relative min-w-0">
      <div className={`grid min-h-16 rounded-[10px] border bg-white ${qOpen || uOpen ? 'border-cta ring-[3px] ring-cta-soft' : 'border-line'} ${wide ? 'grid-cols-[minmax(0,1fr)_210px]' : 'grid-cols-[minmax(0,1fr)_150px]'} max-sm:grid-cols-1`}>
        {plate}<div className="flex min-w-0 border-l border-line max-sm:border-l-0 max-sm:border-t">{right}</div>
      </div>
      {menu}
    </div>
  );
  const once = (lab: string, field: 'qv' | 'tset' | 'k', v: number | undefined, unit: string, id = l.id, pre?: string) => (
    <OnceField key={`${id}:${field}`} label={lab} value={v} unit={unit} pre={pre}
      onChange={setNum((y, n) => { if (field === 'qv') y.q.v = n; if (field === 'tset') y.t.p = n; if (field === 'k') y.q.k = n; }, id)} />
  );

  const head = multi && (
    <div className="mb-1.5 flex items-center gap-2">
      <button type="button" title="Прибавить или вычесть" onClick={() => upLine(l.id, (y) => { y.sign = y.sign < 0 ? 1 : -1; })}
        className={`size-[30px] rounded-full border text-[16px] font-bold ${l.sign < 0 ? 'border-ok bg-ok text-white' : 'border-line bg-white text-accent'}`}>{l.sign < 0 ? '−' : '+'}</button>
      <input value={l.name} placeholder={`строка ${i + 1}`} aria-label="Название строки" maxLength={30} onChange={(x) => upLine(l.id, (y) => { y.name = x.target.value; })}
        className="w-40 rounded-md border border-transparent px-1.5 py-1 text-[13px] font-semibold hover:border-line focus:border-accent focus:outline-none" />
      <button type="button" title="Убрать строку" aria-label="Убрать строку"
        onClick={() => up((x) => {
          x.cfg.lines = x.cfg.lines.filter((y) => y.id !== l.id && !(night && y.id === night.id));
          for (const y of x.cfg.lines) if (y.q.ref === l.id) y.q.ref = x.cfg.lines.find((z) => z !== y)?.id;
          if (x.cfg.pay.baseLine === l.id) x.cfg.pay.baseLine = undefined;
          setOpen(null);
        })}
        className="ml-auto flex size-[30px] items-center justify-center rounded-[7px] border border-line text-muted hover:border-[#f1cfc6] hover:bg-bad-soft hover:text-bad"><X size={16} /></button>
    </div>
  );

  const wrap = (body: React.ReactNode) => <div className={i && !isNightRow(L, l) ? 'mt-3 border-t border-dashed border-line pt-3' : ''}>{head}{body}</div>;

  if (isRub(l)) {
    return wrap(
      <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_22px_minmax(0,1fr)]">
        {group(k === 'rub' ? <Monthly what="сумму квитанции" /> : <Field label="Сумма в месяц">{once('Сумма в месяц', 'qv', l.q.v, '₽')}</Field>, true)}
      </div>,
    );
  }

  const unitField = (
    <Field label="Ед. изм.">
      <div className="relative">
        <button type="button" onClick={() => setOpen(uOpen ? null : `${l.id}:u`)}
          className={`flex h-8 w-full items-center justify-between rounded-[7px] border bg-white px-2.5 ${uOpen ? 'border-accent' : 'border-line hover:border-accent'}`}>
          <b>{l.unit}</b><i className="not-italic text-[12px] text-muted">▾</i>
        </button>
        {uOpen && (
          <div className="absolute left-0 top-[calc(100%+6px)] z-20 w-[150px] rounded-lg border border-line bg-white p-1 shadow-[0_6px_18px_rgba(44,62,80,.12)]">
            {UNITS.map((u) => <DdItem key={u} on={u === l.unit} title={u} onClick={() => { upLine(l.id, (y) => {
              y.unit = u;
              const ok = candidates(u).map((o) => o.id);
              y.q.srcs = (y.q.srcs ?? []).filter((s) => ok.includes(s));
              if (y.q.src === 'sum' && !y.q.srcs.length) y.q.srcs = ok;
            }); setOpen(null); }} />)}
          </div>
        )}
      </div>
    </Field>
  );

  const right: React.ReactNode[] = [];
  if (l.q.src === 'month') right.push(<Monthly key="m" what={`объём, ${l.unit}`} />);
  if (l.q.src === 'const') right.push(<Field key="c" label="Объём">{once('Объём', 'qv', l.q.v, l.unit)}</Field>);
  if (l.q.src === 'norm') right.push(<Field key="n" label={`Норма${refL ? ' на 1 ' + refL.unit : ''}`}>{once('Норма', 'k', l.q.k, l.unit)}</Field>);
  if (l.q.src === 'sum') right.push(<Field key="s" label="Объём"><span className="flex h-8 items-center truncate rounded-[7px] bg-[#f7f8f9] px-2 text-[12px] text-muted">= из выбранных счётчиков</span></Field>);
  if (l.t.mode === 'set') right.push(night
    ? <Field key="t" label={`Тариф, ₽ за ${l.unit}`}><div className="flex gap-2">{once('Тариф днём', 'tset', l.t.p, '₽', l.id, 'день')}{once('Тариф ночью', 'tset', night.t.p, '₽', night.id, 'ночь')}</div></Field>
    : <Field key="t" label={`Тариф, ₽ за ${l.unit}`}>{once('Тариф', 'tset', l.t.p, '₽')}</Field>);
  else if (l.t.mode === 'month') right.push(<Monthly key="t" what={`тариф, ₽ за ${l.unit}`} />);
  else right.push(<Monthly key="t" what="сумму квитанции — тариф выйдет сам" label="Тариф = сумма ÷ объём, вписываем:" />);

  return wrap(
    <div className="grid items-stretch gap-2 md:grid-cols-[minmax(0,1fr)_22px_minmax(0,1fr)]">
      {group(unitField, false)}
      <span className="self-center text-center text-[20px] font-semibold text-muted max-md:hidden">×</span>
      <div className="flex min-h-16 divide-x divide-line rounded-[10px] border border-line bg-white max-sm:flex-col max-sm:divide-x-0 max-sm:divide-y">{right}</div>
    </div>,
  );
}

/** Ещё строки: своя, доплата, скидка, подогрев по норме. */
function AddLines({ L, up }: { L: ReceiptLine[]; up: Up }) {
  const water = L.find((l) => l.unit === 'м³' && l.q.src === 'each');
  const add = (fn: (L: ReceiptLine[], id: string) => ReceiptLine) => up((x) => {
    const first = x.cfg.lines[0];
    if (x.cfg.lines.length === 1 && !first.name) first.name = isRub(first) ? 'сумма' : first.unit === 'м³' ? 'вода' : 'основная';
    x.cfg.lines.push(fn(x.cfg.lines, nextLineId(x.cfg.lines)));
  });
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      <Chip dashed on={false} onClick={() => add((ls, id) => { const last = ls[ls.length - 1]; return blankLine(id, { unit: last.unit, q: { src: last.q.src === 'norm' ? 'month' : last.q.src, read: last.q.read }, t: { mode: last.t.mode } }); })}>+ Строка</Chip>
      <Chip dashed on={false} onClick={() => add((_, id) => blankLine(id, { name: 'доплата', q: { src: 'month' } }))}>+ Доплата</Chip>
      <Chip dashed on={false} onClick={() => add((_, id) => blankLine(id, { name: 'скидка', sign: -1, q: { src: 'const' } }))}>+ Скидка</Chip>
      {water && !L.some((l) => l.q.src === 'norm') && (
        <Chip dashed on={false} onClick={() => add((_, id) => blankLine(id, { name: 'подогрев', unit: 'Гкал', q: { src: 'norm', k: 0.06, ref: water.id } }))}>+ Подогрев по норме</Chip>
      )}
    </div>
  );
}

/** Переключатели первой строки: всегда на месте, неподходящие — серые. */
function Switches({ L, up }: { L: ReceiptLine[]; up: Up }) {
  const l0 = L[0];
  if (!l0) return null;
  const meter = l0.q.src === 'each' && !isRub(l0), dn = !!nightOf(L, l0);
  const hasT = !isRub(l0), fs = hasT && l0.t.mode === 'sum' && l0.q.src !== 'const' && l0.q.src !== 'month';
  const set = (fn: (l: ReceiptLine, x: ReceiptDraft) => void) => up((x) => fn(x.cfg.lines[0], x));
  return (
    <div className="mt-2.5 flex min-h-[34px] flex-wrap items-center gap-2">
      <span className="inline-flex items-center gap-1.5"><span className="text-[12px] text-muted">Показания</span>
        <Seg disabled={!meter} value={l0.q.read === 'direct' ? 'direct' : 'diff'} items={[['diff', 'было → стало'], ['direct', 'сразу расход']]} onPick={(v) => set((l) => { l.q.read = v; })} /></span>
      <Chip on={dn} disabled={!meter} onClick={() => set((l, x) => {
        const n = nightOf(x.cfg.lines, l);
        if (n) { x.cfg.lines = x.cfg.lines.filter((y) => y !== n); l.name = ''; }
        else { l.name = 'день'; x.cfg.lines.splice(1, 0, blankLine(nextLineId(x.cfg.lines), { name: 'ночь', unit: l.unit, q: { src: 'each', read: l.q.read }, t: { mode: l.t.mode } })); }
      })}>День / ночь</Chip>
      <span className="inline-flex items-center gap-1.5"><span className="text-[12px] text-muted">Тариф</span>
        <Seg disabled={!hasT} value={l0.t.mode} items={[['set', 'постоянный'], ['month', 'меняется'], ['sum', 'из суммы']]} onPick={(v) => set((l) => { l.t.mode = v; if (v !== 'sum') l.t.common = false; })} /></span>
      <Chip on={!!(fs && l0.t.common)} disabled={!(fs && meter)} onClick={() => set((l) => { l.t.common = !l.t.common; })}>Общий счётчик — разница на вас</Chip>
    </div>
  );
}

/** Счётчики арендаторов: № и к кому привязан — строка на арендатора. */
function MeterStrip({ l, L, off, tenants, upLine }: { l: ReceiptLine; L: ReceiptLine[]; off: string[]; tenants: T[]; upLine: UpLine }) {
  const setNo = (who: string) => (v: string) => upLine(l.id, (y) => { y.meters = { ...(y.meters ?? {}) }; if (v.trim()) y.meters[who] = v.trim(); else delete y.meters[who]; });
  const row = (key: string, name: string, body: React.ReactNode, note: string) => (
    <div key={key} className="grid items-center gap-3 border-t border-line py-1.5 text-[14px] md:grid-cols-[200px_240px_1fr]">
      <span className="truncate">{name}</span>{body}<span className="text-[12px] text-muted">{note}</span>
    </div>
  );
  return (
    <div className="mt-2.5 rounded-[10px] border border-line bg-white px-3 py-2">
      <div className="flex items-center gap-1.5 pb-1.5 text-[12px] text-muted"><CalendarDays size={15} className="text-[#3b78c4]" />Счётчики арендаторов — показания вписываете каждый месяц на странице объекта</div>
      {tenants.length === 0 && row('me', 'Собственник', <OnceField label="№ счётчика" text optional value={l.meters?.common} onChange={setNo('common')} placeholder="№ счётчика — необязательно" />, 'весь объект')}
      {tenants.map((t) => off.includes(t.id)
        ? <div key={t.id} className="grid gap-3 border-t border-line py-1.5 text-[14px] md:grid-cols-[200px_1fr]"><span className="truncate text-muted">{t.name}</span><span className="text-[12px] text-muted">платит сам — счётчик не нужен</span></div>
        : row(t.id, t.name, <OnceField label={`№ счётчика: ${t.name}`} text optional value={l.meters?.[t.id]} onChange={setNo(t.id)} placeholder="№ счётчика — необязательно" />,
          `${l.q.read === 'direct' ? 'расход' : 'было → стало'}${nightOf(L, l) ? ', день и ночь' : ''}`))}
      {tenants.length > 0 && l.t.mode === 'sum' && l.t.common && row('common', 'Общий счётчик',
        <OnceField label="№ общего счётчика" text optional value={l.meters?.common} onChange={setNo('common')} placeholder="№ общего счётчика" />, 'весь объект')}
    </div>
  );
}

/** «Распределяем затраты» — одна строка: кто платит, как делим, пустующая доля, остаток. */
function PayRow({ cfg, tenants, up }: { cfg: ReceiptConfig; tenants: T[]; up: Up }) {
  const P = cfg.pay, L = cfg.lines;
  const common = L.some((l) => l.q.src === 'const' || l.q.src === 'month' || (l.q.src === 'norm' && !['each', 'sum'].includes(L.find((x) => x.id === l.q.ref)?.q.src ?? '')));
  const vacant = Math.max(0, 100 - tenants.reduce((a, t) => a + t.share, 0));
  const vacOn = vacant > 0 && P.vacant !== false;
  const payers = tenants.filter((t) => !P.off.includes(t.id));
  const qtyLines = L.filter((l) => !isRub(l));
  const setP = (fn: (pay: ReceiptConfig['pay']) => void) => up((x) => fn(x.cfg.pay));
  return (
    <div className="mt-2.5 flex min-h-[58px] flex-wrap items-center gap-x-5 gap-y-2.5 rounded-[10px] border border-line bg-white px-3.5 py-3">
      {tenants.length > 0 && (
        <span className="flex flex-wrap items-center gap-1.5"><span className="mr-0.5 text-[12px] text-muted">Платят</span>
          {tenants.map((t) => (
            <Chip key={t.id} on={!P.off.includes(t.id)} onClick={() => setP((pay) => { pay.off = pay.off.includes(t.id) ? pay.off.filter((x) => x !== t.id) : [...pay.off, t.id]; })}>{t.name}</Chip>
          ))}
          {!payers.length && <span className="text-[12px] font-semibold text-cta-ink">платите вы — арендаторам не перевыставляется</span>}
        </span>
      )}
      <span className="flex flex-wrap items-center gap-1.5"><span className="mr-0.5 text-[12px] text-muted">Делим</span>
        {common
          ? <Seg value={P.mode} items={[['shares', 'по долям'], ['equal', 'поровну']]} onPick={(v) => setP((pay) => { pay.mode = v; })} />
          : <Seg disabled value={'m' as const} items={[['m', 'по счётчику'], ['x', '—']]} onPick={() => {}} />}
      </span>
      {vacant > 0 && tenants.length > 0 && (
        <Chip on={vacOn} onClick={() => setP((pay) => { pay.vacant = !vacOn; })}>{`Пустует ${fmtQty(vacant)}% — на вас`}</Chip>
      )}
      {qtyLines.length > 0 && (
        <span className="flex flex-wrap items-center gap-1.5"><span className="mr-0.5 text-[12px] text-muted">Остаток квитанции</span>
          <Seg value={P.rest} items={[['none', 'нет'], ['shares', 'по долям'], ['equal', 'поровну'], ['self', 'на вас']]}
            onPick={(v) => setP((pay) => { pay.rest = v; if (v !== 'none' && pay.base === 'qty' && !pay.baseLine) pay.baseLine = qtyLines[qtyLines.length - 1].id; })} />
          {P.rest !== 'none' && (
            <Seg value={P.base === 'total' ? 'total' : P.baseLine ?? ''} onPick={(v) => setP((pay) => { if (v === 'total') pay.base = 'total'; else { pay.base = 'qty'; pay.baseLine = v; } })}
              items={[['total', 'от итога'], ...qtyLines.map((l, j) => [l.id, `от количества · ${l.name || l.unit || 'строка ' + (j + 1)}`] as [string, string])]} />
          )}
        </span>
      )}
    </div>
  );
}

/** Пример расчёта: по строке на арендатора, подписи колонок — один раз сверху. Серым — примерные числа. */
function Formula({ C, pcfg, cfg, tenants, newR }: { C: ReturnType<typeof calcReceipt>; pcfg: ReceiptConfig; cfg: ReceiptConfig; tenants: T[]; newR: boolean }) {
  const off = cfg.pay.off;
  const sharesTotal = tenants.reduce((a, t) => a + t.share, 0), vacant = Math.max(0, 100 - sharesTotal);
  const vacOn = vacant > 0 && cfg.pay.vacant !== false;
  const effShare = (t: T) => { const D = vacOn ? Math.max(100, sharesTotal) : sharesTotal; return D ? (t.share / D) * 100 : 0; };
  type Col = { op: string } | { lab: string; ex?: boolean; v: (t: T) => string };
  const cols: Col[] = [];
  let anyEx = false;
  C.lines.forEach(({ l, Qi, pr }, i) => {
    const rub = isRub(l), dl = cfg.lines[i] ?? l, lab = C.lines.length > 1 ? lineLabel(pcfg, l, i) + ' · ' : '';
    const exQ = (l.q.src === 'const' && dl.q.v == null) || (newR && l.q.src !== 'const');
    const exT = !rub && ((l.t.mode === 'set' && dl.t.p == null) || (newR && l.t.mode !== 'set'));
    const ref = Qi.ref ? Qi.ref.name || 'строка ' + (pcfg.lines.indexOf(Qi.ref) + 1) : '?';
    if (i) cols.push({ op: l.sign < 0 ? '−' : '+' });
    const head = { each: `Расход, ${l.unit}`, month: rub ? 'Сумма квитанции' : `Объём, ${l.unit}`, const: rub ? 'Сумма в месяц' : `Объём, ${l.unit}`, sum: `Объём, ${l.unit}`, norm: `Норма × ${ref}, ${l.unit}` }[l.q.src];
    cols.push({ lab: lab + head, ex: exQ, v: (t) => (Qi.miss.length || Qi.cfgMiss ? '…' : rub ? fmtMoney(Qi.Q) + ' ₽' : fmtQty(Qi.ind ? Qi.per[t.id] : Qi.Q)) });
    if (!rub) { cols.push({ op: '×' }); cols.push({ lab: pr.fromSum ? 'Тариф = сумма ÷ объём' : 'Тариф, ₽', ex: exT, v: () => (pr.miss.length ? '…' : fmtPrice(pr.p)) }); }
    if (!Qi.ind) {
      if (cfg.pay.mode === 'equal') { cols.push({ op: '÷' }); cols.push({ lab: 'Частей', v: () => String(tenants.length + (vacOn ? 1 : 0)) }); }
      else { cols.push({ op: '×' }); cols.push({ lab: 'Доля', v: (t) => pct(effShare(t)) }); }
    }
    if (exQ || exT) anyEx = true;
  });
  if (C.rest && C.rest.money > 0) {
    cols.push({ op: '+' });
    cols.push({ lab: 'Остаток', ex: newR, v: (t) => { const x = (C.per[t.id] ?? []).find((y) => y.rest); return x ? fmtMoney(x.sum) + ' ₽' : '—'; } });
    if (newR) anyEx = true;
  }
  const k = coefOf(pcfg);
  if (k !== 1) { cols.push({ op: '×' }); cols.push({ lab: 'Коэф.', v: () => fmtQty(k) }); }
  const grey = 'text-[#b6bfc9]';
  return (
    <div className="mt-4 rounded-[10px] bg-[#eef1f4] px-3.5 py-3" aria-live="polite">
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.5px] text-muted">Пример расчёта</div>
      <div className="overflow-x-auto">
        <table className="border-collapse text-[14px]">
          <thead><tr><th />{cols.map((c, j) => <th key={j} className="whitespace-nowrap px-2 pb-0.5 text-center text-[11px] font-medium text-muted">{'op' in c ? '' : c.lab}</th>)}<th /><th className="px-2 pb-0.5 text-[11px] font-medium text-muted">Итого</th></tr></thead>
          <tbody>
            {tenants.map((t, r) => (
              <tr key={t.id} className={off.includes(t.id) ? 'text-muted' : ''}>
                <td className={`min-w-[140px] whitespace-nowrap pr-2 text-left ${r ? 'pt-2.5' : 'pt-1.5'}`}>{t.name}</td>
                {off.includes(t.id)
                  ? <><td colSpan={cols.length + 1} className="px-2 pt-1.5 italic">платит сам — в счёт не идёт</td><td className="px-2 pt-1.5 text-right font-bold">—</td></>
                  : <>
                    {cols.map((c, j) => ('op' in c
                      ? <td key={j} className={`px-0.5 text-[16px] text-muted ${r ? 'pt-2.5' : 'pt-1.5'}`}>{c.op}</td>
                      : <td key={j} className={`px-2 ${r ? 'pt-2.5' : 'pt-1.5'}`}><span className={`inline-block min-w-20 whitespace-nowrap border-b-[1.5px] border-[#b6bfc9] px-1.5 pb-[3px] text-center text-[16px] font-semibold ${c.ex ? grey : ''}`}>{c.v(t)}</span></td>))}
                    <td className={`px-0.5 text-[16px] text-muted ${r ? 'pt-2.5' : 'pt-1.5'}`}>=</td>
                    <td className={`min-w-[110px] whitespace-nowrap px-2 text-right text-[16px] font-bold ${r ? 'pt-2.5' : 'pt-1.5'} ${anyEx ? grey : ''}`}>{C.ready ? fmtMoney(tenantSum(pcfg, C, t.id)) + ' ₽' : '…'}</td>
                  </>}
              </tr>
            ))}
            {C.ready && (C.mine > 0 || tenants.length === 0) && (
              <tr className="text-cta-ink"><td className="pt-2.5 pr-2">На вас</td><td colSpan={cols.length + 1} /><td className={`pt-2.5 px-2 text-right text-[16px] font-bold ${anyEx ? grey : ''}`}>{fmtMoney(C.mine)} ₽</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="mt-2 min-h-[18px] border-t border-[#d5dbe1] pt-1.5 text-[12px] text-muted">
        {C.cfg.length ? 'Не выбрано: ' + C.cfg.join('; ') : anyEx ? 'Серым — пример. Настоящие суммы и показания впишете на странице объекта.' : ' '}
      </div>
    </div>
  );
}
