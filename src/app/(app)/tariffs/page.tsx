import Link from 'next/link';
import { Pencil, Plus } from 'lucide-react';
import { requireUser } from '@/lib/auth/session';
import { listObjects, loadServices } from '@/lib/data';
import { LOGICS } from '@/lib/calc/logics';
import type { Tariff } from '@/lib/calc/types';
import { MoveButtons } from './move-buttons';

export const metadata = { title: 'Тарифы и услуги' };

/** Цена: минимум 2 знака после запятой (27,5 → 27,50), больше — как ввели (11,0348). */
const num = (n?: number) => {
  if (n === undefined) return '—';
  const [i, f = ''] = String(n).split('.');
  return i.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0') + ',' + f.padEnd(2, '0');
};
const date = (d: string) => d.split('-').reverse().join('.');

/** Тип счёта в таблице: цветная точка и короткое слово вместо плашки. */
const KIND_SHORT = {
  common: { label: 'Общий', dot: '#2f7a55' },
  indiv: { label: 'Индивидуальный', dot: '#34495e' },
  owner: { label: 'Арендодатель', dot: '#c8663b' },
} as const;

function priceText(t: Tariff, unit: string): [string, string] {
  switch (t.logic) {
    case 'share': return ['доля', ''];
    case 'split': return ['по счёту', ''];
    case 'whole': return ['вся сумма', ''];
    case 'fixed': return [num(t.price), '₽/мес'];
    case 'dn': return [`${num(t.price)} / ${num(t.price2)}`, `₽/${unit} день / ночь`];
    case 'norm': return [num(t.price), `₽ × ${num(t.norm)}`];
    case 'meterRest': return [num(t.price), `₽/${unit} + остаток`];
    default: return [num(t.price), `₽/${unit}`];
  }
}

export default async function TariffsPage({ searchParams }: PageProps<'/tariffs'>) {
  const user = await requireUser();
  const sp = await searchParams;
  const [services, objects] = await Promise.all([loadServices(user.accountId), listObjects(user.accountId)]);
  const tenantObj = new Map<string, { name: string; obj: string; objId: string }>();
  objects.forEach((o) => o.tenants.forEach((t) => tenantObj.set(t.id, { name: t.name, obj: o.short, objId: o.id })));
  const svcName = new Map(services.map((s) => [s.id, s.name]));
  const filter = typeof sp.o === 'string' && objects.some((o) => o.id === sp.o) ? sp.o : 'all';

  const whoText = (t: Tariff) => {
    if (t.who === 'all') return null;
    const byObj = new Map<string, string[]>();
    t.who.forEach((id) => { const x = tenantObj.get(id); if (x) byObj.set(x.obj, [...(byObj.get(x.obj) ?? []), x.name]); });
    return [...byObj.entries()].map(([o, ns]) => `${o}: ${ns.join(', ')}`).join(' · ') || 'никто не выбран';
  };
  // Квитанции из строк настраиваются в окне квитанции объекта, тарифы у них не используются.
  const visible = services.filter((s) => !s.config).filter((s) => filter === 'all' || s.kind === 'owner' ||
    s.tariffs.some((t) => t.who === 'all' || t.who.some((id) => tenantObj.get(id)?.objId === filter)));

  const chip = (id: string, label: string) => (
    <Link key={id} href={id === 'all' ? '/tariffs' : `/tariffs?o=${id}`} aria-pressed={filter === id}
      className={`rounded-full border px-3.5 py-1.5 font-semibold ${filter === id ? 'border-nav bg-nav text-white' : 'border-line-strong bg-white text-[#4d5f71]'}`}>{label}</Link>
  );

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-[22px] font-bold">Тарифы и услуги</h1>
        <div className="flex-1" />
        <Link href="/tariffs/new" className="btn btn-primary"><Plus size={16} /> Создать услугу</Link>
      </div>
      <p className="max-w-[900px] text-[13px] text-muted">
        Услуга — одна строка квитанции поставщика (например, «Водоканал — холодная вода»). Внутри услуги — тарифы: логика расчёта, цена и арендаторы,
        для которых она действует. Нажмите на название или ✎, чтобы изменить услугу. Стрелки в столбце «№» задают порядок строк в «Вводе данных», «Расчёте» и отчёте.
      </p>
      <div role="group" aria-label="Фильтр по объекту" className="flex flex-wrap gap-2">
        {chip('all', 'Все объекты')}
        {objects.map((o) => chip(o.id, o.short))}
      </div>

      {visible.length === 0 && (
        <div className="card p-6 text-ink-2">Услуг пока нет. <Link href="/tariffs/new" className="font-semibold text-accent">Создайте первую</Link> — например, «Водоканал — холодная вода».</div>
      )}

      {visible.length > 0 && (
        /* Таблица: всё по левому краю, фиксированные ширины столбцов; зебра; шапка и «Услуга» закреплены при прокрутке. */
        <div className="card max-h-[calc(100vh-230px)] overflow-auto shadow-card">
          <table className="w-full min-w-[900px] table-fixed border-separate border-spacing-0 text-left text-[13px]">
            <colgroup>
              <col className="w-[78px]" /><col className="w-[22%]" /><col className="w-[14%]" /><col className="w-[17%]" /><col className="w-[21%]" /><col className="w-[14%]" /><col className="w-[11%]" /><col className="w-[52px]" />
            </colgroup>
            <thead>
              <tr className="text-[12px] text-muted">
                {[['№', ''], ['Услуга', 'sticky left-0 z-20'], ['Счёт', ''], ['Логика расчёта', ''], ['Для кого', ''], ['Цена', ''], ['С даты', ''], ['', '']].map(([h, c], k) => (
                  <th key={k} className={`sticky top-0 z-10 border-b border-line bg-[#f6f8fb] px-3 py-2.5 font-semibold ${c}`}>{h}</th>
                ))}
              </tr>
            </thead>
            {visible.map((s, idx) => {
              const K = KIND_SHORT[s.kind];
              const ts = [...s.tariffs].sort((a, b) => b.from.localeCompare(a.from));
              const rows = ts.length ? ts : [null];
              const span = rows.length;
              const bg = idx % 2 ? 'bg-[#f4f6f8]' : 'bg-white';
              const cell = `border-b border-[#edf0f5] px-3 py-2.5 align-top ${bg}`;
              return (
                <tbody key={s.id} id={`s-${s.id}`} className="group">
                  {rows.map((t, i) => {
                    const [p, u] = t ? priceText(t, s.unit) : ['—', ''];
                    const who = t ? whoText(t) : null;
                    const last = i === rows.length - 1;
                    const tc = `${cell} ${last ? '' : 'border-b-[#f0f2f5] border-dashed'}`;
                    return (
                      <tr key={i}>
                        {i === 0 && (
                          <>
                            <td rowSpan={span} className={cell}>
                              <span className="flex items-center gap-1">
                                <span className="w-5 tabular-nums text-ink-2">{idx + 1}</span>
                                <span className="opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
                                  <MoveButtons compact pos={idx + 1} up={visible[idx - 1]?.id} down={visible[idx + 1]?.id} id={s.id} name={s.name} />
                                </span>
                              </span>
                            </td>
                            <td rowSpan={span} className={`${cell} sticky left-0 z-[1]`}>
                              <Link href={`/tariffs/${s.id}`} className="font-semibold text-ink hover:text-cta-ink hover:underline">{s.name}</Link>
                              <span className="block text-[12px] text-faint">{s.supplier}</span>
                            </td>
                            <td rowSpan={span} className={`${cell} whitespace-nowrap`}>
                              <span className="mr-2 inline-block size-[7px] rounded-full align-[1px]" style={{ background: K.dot }} aria-hidden />{K.label}
                            </td>
                          </>
                        )}
                        <td className={`${tc} text-ink-2`}>
                          {t ? <span title={(t.logic === 'derived' || t.logic === 'norm') && t.sources?.length
                              ? `(${t.sources.map((x) => svcName.get(x) ?? '?').join(' + ')})${t.logic === 'norm' ? ' × норматив' : ''} × цена` : LOGICS[t.logic].formula}>{LOGICS[t.logic].label}</span>
                            : <span className="text-muted">тарифов нет</span>}
                        </td>
                        <td className={tc}>
                          {!t ? '—' : s.kind === 'owner' ? <span className="text-muted">платит арендодатель</span> : who === null ? 'Все' : who}
                        </td>
                        <td className={`${tc} whitespace-nowrap`}>
                          <span className={`tabular-nums ${/\d/.test(p) ? 'font-semibold' : 'text-muted'}`}>{p}</span> <span className="text-[12px] text-faint">{u}</span>
                        </td>
                        <td className={`${tc} whitespace-nowrap tabular-nums text-muted`}>{t ? date(t.from) : '—'}</td>
                        {i === 0 && (
                          <td rowSpan={span} className={`${cell} py-2`}>
                            <Link href={`/tariffs/${s.id}`} aria-label={`Изменить услугу ${s.supplier} — ${s.name}`} title="Изменить"
                              className="flex size-8 items-center justify-center rounded-lg text-faint opacity-0 transition hover:bg-white hover:text-cta-ink focus:opacity-100 group-hover:opacity-100"><Pencil size={15} /></Link>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              );
            })}
          </table>
        </div>
      )}
    </>
  );
}
