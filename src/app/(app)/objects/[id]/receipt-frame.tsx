'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { MoreHorizontal, Pencil } from 'lucide-react';
import { isRub, lineLabel, meterLines, monthFields, usageOf, type ReceiptCalc } from '@/lib/calc/lines';
import { fmtMoney, fmtPrice, fmtQty } from '@/lib/calc/format';
import type { ReceiptConfig, Reading } from '@/lib/calc/types';
import { saveReading, saveReceiptConst, saveReceiptValue } from '../actions';
import { deleteReceipt } from './receipt/actions';

export type FrameData = {
  id: string; name: string; supplier: string; cfg: ReceiptConfig; C: ReceiptCalc;
  values: Record<string, number | undefined>;
  /** Показания этого месяца: tenantId → ключ строки → показание («было» — из прошлого месяца, если не вписано). */
  readings: Record<string, Record<string, Reading | undefined>>;
};

const show = (n: number | undefined) => (n === undefined ? '' : String(n).replace('.', ','));
const parse = (s: string) => { const n = Number(s.replace(/\s/g, '').replace(',', '.')); return s.trim() && Number.isFinite(n) ? n : null; };

/** Рамка квитанции на странице объекта: только то, что вписывается каждый месяц. Сохраняется при уходе из поля. */
export function ReceiptFrame({ f, objectId, month, tenants }: { f: FrameData; objectId: string; month: string; tenants: Array<{ id: string; name: string }> }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [menu, setMenu] = useState(false);
  const [sure, setSure] = useState(false);
  const [unlocked, setUnlocked] = useState<Set<string>>(new Set());
  const menuRef = useRef<HTMLDivElement>(null);
  const run = (fn: () => Promise<unknown>) => start(async () => { await fn(); router.refresh(); });
  const { cfg, C } = f;
  const q = `?m=${month}`;

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) { setMenu(false); setSure(false); } };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menu]);

  const money = (label: string, value: number | undefined, save: (v: string) => Promise<unknown>, cls = 'max-w-[150px]') => (
    <input inputMode="decimal" aria-label={label} defaultValue={show(value)} key={`${label}|${value ?? ''}`}
      className={`w-full rounded-[7px] border px-2.5 py-2 text-right outline-none focus:border-accent ${cls} ${value === undefined ? 'border-[#f0dcb5] bg-warn-soft' : 'border-line bg-white'}`}
      onBlur={(e) => { if (parse(e.target.value) !== (value ?? null)) run(() => save(e.target.value)); }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
  );

  const fields = monthFields(cfg);
  const E = meterLines(cfg).map((l) => ({ l, j: cfg.lines.indexOf(l) }));
  const grp = E.length > 1 || !!E[0]?.l.name;
  const payers = tenants.filter((t) => !cfg.pay.off.includes(t.id));

  // Постоянные значения: вписываются один раз, потом стоят под замком ✎.
  const cs: Array<{ key: string; lid: string; a: 'qv' | 'tset' | 'k'; lab: string; u: string; v: number | undefined }> = [];
  cfg.lines.forEach((l, j) => {
    const lab = lineLabel(cfg, l, j), sfx = lab ? ' · ' + lab : '';
    if (l.q.src === 'const') cs.push({ key: `${l.id}:qv`, lid: l.id, a: 'qv', lab: (isRub(l) ? 'Сумма' : 'Объём') + sfx, u: isRub(l) ? '₽' : l.unit, v: l.q.v });
    if (!isRub(l) && l.t.mode === 'set') cs.push({ key: `${l.id}:tset`, lid: l.id, a: 'tset', lab: 'Тариф' + sfx, u: '₽/' + l.unit, v: l.t.p });
    if (l.q.src === 'norm') { const ref = cfg.lines.find((x) => x.id === l.q.ref); cs.push({ key: `${l.id}:k`, lid: l.id, a: 'k', lab: 'Норма' + sfx, u: l.unit + (ref ? ' на ' + ref.unit : ''), v: l.q.k }); }
  });

  const hasInd = cfg.lines.some((l) => ['each', 'sum', 'norm'].includes(l.q.src));
  const tag = !payers.length && tenants.length ? 'на вас' : hasInd ? 'по счётчику' : cfg.pay.mode === 'equal' ? 'поровну' : 'по долям';

  return (
    <div id={`r-${f.id}`} className={`rounded-[10px] border border-line p-3.5 ${pending ? 'opacity-70' : ''}`}>
      <div className="mb-2.5 flex items-start justify-between gap-2.5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2"><b>{f.name}</b><span className="whitespace-nowrap rounded-full bg-cta-soft px-2 py-0.5 text-[12px] text-cta-ink">{tag}</span></div>
          <span className="hint text-[13px]">{f.supplier || 'Поставщик не указан'}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="flex items-center gap-1 whitespace-nowrap text-[12px] text-muted" title="Коэффициент к начислению арендаторам. Например 1,06 — чтобы покрыть налог 6%">
            коэф. ×
            <input inputMode="decimal" aria-label="Коэффициент" defaultValue={show(cfg.coef)} key={cfg.coef}
              className={`w-[62px] rounded-[7px] border px-1 py-2 text-center outline-none focus:border-accent ${cfg.coef !== 1 ? 'border-cta font-semibold text-cta-ink' : 'border-line'}`}
              onBlur={(e) => { if ((parse(e.target.value) ?? 1) !== cfg.coef) run(() => saveReceiptConst(objectId, f.id, '', 'coef', e.target.value)); }} />
          </span>
          <div ref={menuRef} className="relative">
            <button type="button" aria-label="Действия" onClick={() => { setMenu(!menu); setSure(false); }}
              className="flex size-[34px] items-center justify-center rounded-lg border border-line bg-white text-muted hover:border-accent hover:text-ink"><MoreHorizontal size={16} /></button>
            {menu && (
              <div className="absolute right-0 top-10 z-10 min-w-[150px] rounded-lg border border-line bg-white p-1 shadow-[0_6px_18px_rgba(44,62,80,.12)]">
                <Link href={`/objects/${objectId}/receipt${q}&s=${f.id}`} className="block rounded-md px-2.5 py-2 hover:bg-[#f7f8f9]">Изменить</Link>
                <button type="button" onClick={() => (sure ? run(() => deleteReceipt(objectId, f.id, month)) : setSure(true))}
                  className={`block w-full rounded-md px-2.5 py-2 text-left text-bad ${sure ? 'bg-bad-soft font-semibold' : 'hover:bg-[#f7f8f9]'}`}>{sure ? 'Точно удалить?' : 'Удалить'}</button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {fields.map((x) => (
          <div key={x.key} className="flex items-center gap-2.5">
            <span className="flex-1 text-[13px] text-muted">{x.label}{x.hint && <small className="block text-[11px] text-faint">{x.hint}</small>}</span>
            {money(x.label, f.values[x.key], (v) => saveReceiptValue(objectId, f.id, month, x.key, v))}
          </div>
        ))}
        {!fields.length && !E.length && <span className="text-[13px] text-muted">Каждый месяц вписывать ничего не нужно — начислится само</span>}
      </div>

      {E.length > 0 && payers.length > 0 && (
        <div className="mt-2.5 overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              {grp && <tr><th />{E.map(({ l, j }) => <th key={l.id} colSpan={l.q.read === 'direct' ? 1 : 3} className="px-1.5 text-center font-semibold">{lineLabel(cfg, l, j)}, {l.unit}</th>)}</tr>}
              <tr className="border-b border-line text-[11px] text-muted">
                <th className="px-1.5 py-1 text-left font-medium">Арендатор</th>
                {E.map(({ l }) => (l.q.read === 'direct'
                  ? <th key={l.id} className="px-1.5 py-1 text-right font-medium">Расход{grp ? '' : ', ' + l.unit}</th>
                  : [<th key={l.id + 'p'} className="px-1.5 py-1 text-right font-medium">Было</th>, <th key={l.id + 'c'} className="px-1.5 py-1 text-right font-medium">Стало</th>, <th key={l.id + 'u'} className="px-1.5 py-1 text-right font-medium">Расход</th>]))}
              </tr>
            </thead>
            <tbody>
              {payers.map((t) => (
                <tr key={t.id} className="border-b border-line last:border-b-0">
                  <td className="w-full px-1.5 py-1">{t.name}{E[0].l.meters?.[t.id] && <small className="block text-[11px] text-muted">№ {E[0].l.meters[t.id]}</small>}</td>
                  {E.map(({ l }) => {
                    const r = f.readings[t.id]?.[l.id];
                    const cell = (field: 'prev' | 'cur' | 'usage', v: number | undefined, need: boolean) => (
                      <td key={l.id + field} className="whitespace-nowrap px-1.5 py-1 text-right">
                        <input inputMode="decimal" aria-label={`${t.name}: ${field === 'prev' ? 'было' : field === 'cur' ? 'стало' : 'расход'}`} defaultValue={show(v)} key={`${field}|${v ?? ''}`}
                          className={`w-[78px] rounded-[7px] border px-1.5 py-[5px] text-right outline-none focus:border-accent ${need && v === undefined ? 'border-[#f0dcb5] bg-warn-soft' : 'border-line bg-white'}`}
                          onBlur={(e) => { if (parse(e.target.value) !== (v ?? null)) run(() => saveReading(t.id, f.id, l.id, month, field, e.target.value)); }}
                          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
                      </td>
                    );
                    if (l.q.read === 'direct') return cell('usage', r?.usage, true);
                    const u = usageOf('diff', r);
                    return [cell('prev', r?.prev, false), cell('cur', r?.cur, true),
                      <td key={l.id + 'u'} className="min-w-16 whitespace-nowrap px-1.5 py-1 text-right text-muted">{u === null ? '—' : `${fmtQty(u)} ${l.unit}`}</td>];
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {cs.length > 0 && (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-muted">
          <span className="font-semibold">Постоянно:</span>
          {cs.map((c) => (c.v === undefined || unlocked.has(c.key)
            ? (
              <label key={c.key} className="inline-flex items-center gap-1">{c.lab}
                <input inputMode="decimal" autoFocus={unlocked.has(c.key)} defaultValue={show(c.v)} aria-label={c.lab}
                  className={`w-20 rounded-[7px] border px-1.5 py-1 text-right outline-none focus:border-accent ${c.v === undefined ? 'border-[#f0dcb5] bg-warn-soft' : 'border-line bg-white'}`}
                  onBlur={(e) => {
                    const v = e.target.value;
                    if (v.trim()) setUnlocked((s) => { const n = new Set(s); n.delete(c.key); return n; });
                    if (parse(v) !== (c.v ?? null)) run(() => saveReceiptConst(objectId, f.id, c.lid, c.a, v));
                  }}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} /> {c.u}
              </label>
            ) : (
              <span key={c.key}>{c.lab} <b className="text-ink">{fmtQty(c.v)}</b> {c.u}
                <button type="button" title="Изменить" aria-label={`Изменить: ${c.lab}`} onClick={() => setUnlocked((s) => new Set(s).add(c.key))}
                  className="px-0.5 align-middle text-muted hover:text-cta-ink"><Pencil size={13} /></button></span>
            )))}
        </div>
      )}

      <div className="mt-2 text-[12px] leading-relaxed text-muted"><Note cfg={cfg} C={C} /></div>
    </div>
  );
}

/** Тихая строка под рамкой: как считается каждая строка и чего ждём. */
function Note({ cfg, C }: { cfg: ReceiptConfig; C: ReceiptCalc }) {
  const parts = C.lines.map(({ l, Qi, pr }, j) => {
    const sg = j ? (l.sign < 0 ? ' − ' : ' + ') : l.sign < 0 ? '− ' : '', lab = lineLabel(cfg, l, j);
    let qt: string;
    if (l.q.src === 'const') qt = isRub(l) ? `${fmtMoney(l.q.v ?? 0)} ₽ в месяц` : `${fmtQty(l.q.v ?? 0)} ${l.unit}`;
    else if (l.q.src === 'month') qt = isRub(l) ? 'сумма каждый месяц' : `${l.unit} каждый месяц`;
    else if (l.q.src === 'each') qt = `${l.unit} у каждого`;
    else if (l.q.src === 'norm') qt = Qi.ref ? `${fmtQty(Qi.k ?? 0)} ${l.unit} × ${lineLabel(cfg, Qi.ref, cfg.lines.indexOf(Qi.ref)) || 'строка ' + (cfg.lines.indexOf(Qi.ref) + 1)}` : 'норма × ?';
    else qt = `${l.unit} из других счётчиков`;
    const t = pr.rub ? '' : pr.fromSum ? ` × вышел тариф ${fmtPrice(pr.p)} ₽ (${fmtMoney(pr.money ?? 0)} ÷ ${fmtQty(pr.base ?? 0)} ${l.unit}${l.t.common ? ' по общему счётчику' : ''})`
      : l.t.mode === 'month' ? ` × тариф месяца ${fmtPrice(pr.p)} ₽` : ` × ${fmtPrice(pr.p)} ₽`;
    return sg + (lab && cfg.lines.length > 1 ? lab + ': ' : '') + qt + t;
  });
  return (
    <>
      {parts.join('')}
      {C.rest && <><br />Остаток: {C.rest.txt} = {fmtMoney(C.rest.money)} ₽ — {({ shares: 'по долям', equal: 'поровну', self: 'на вас', none: '' })[cfg.pay.rest]}</>}
      {C.mine > 0 && <><br /><span className="text-cta-ink">На вас: {fmtMoney(C.mine)} ₽</span></>}
      {C.cfg.length ? <><br /><span className="text-bad">Не настроено: {C.cfg.join('; ')} — «⋯ → Изменить»</span></>
        : C.miss.length ? <><br />Ждём: {C.miss.join(', ')}</> : null}
    </>
  );
}
