import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { Building2, Check, CircleAlert, FileText, Plus } from 'lucide-react';
import { db, schema } from '@/db';
import { requireUser } from '@/lib/auth/session';
import { listInvoices, listMeters, loadMonthInput, objectBillsOf } from '@/lib/data';
import { activeTariff, calculateMonth, lineKey, receiptCalcOf } from '@/lib/calc/engine';
import { monthFields } from '@/lib/calc/lines';
import { fmtMoney, rubWords, sumMoney } from '@/lib/calc/format';
import type { BillLine } from '@/lib/calc/types';
import { defaultMonth, isMonth, monthLabel, shiftMonth } from '@/lib/month';
import { readRequisites } from '@/lib/requisites';
import { METHODS, RESOURCES, category, type Method, type Resource } from '@/lib/receipts';
import { MonthNav } from '@/components/month-nav';
import { KindIcon } from '@/components/kind-icon';
import { ReceiptFrame, type FrameData } from './receipt-frame';

const pctTxt = (v: number) => String(v).replace('.', ',') + '%';

export default async function ObjectPage({ params, searchParams }: PageProps<'/objects/[id]'>) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await requireUser();
  const month = isMonth(sp.m) ? sp.m : defaultMonth();
  const [{ input, objects }, invoices, meters, prevBills, [acc]] = await Promise.all([
    loadMonthInput(user.accountId, month), listInvoices(user.accountId, month), listMeters(user.accountId, id), objectBillsOf(id, shiftMonth(month, -1)),
    db.select({ name: schema.accounts.name, requisites: schema.accounts.requisites }).from(schema.accounts).where(eq(schema.accounts.id, user.accountId)).limit(1),
  ]);
  const issued = new Set(invoices.map((i) => i.tenantId));
  const obj = objects.find((o) => o.id === id);
  if (!obj) notFound();
  const res = calculateMonth(input);
  const q = `?m=${month}`;

  // Квитанции объекта за месяц и их состояние. Квитанция из строк — рамка с вводом месяца; старая — строка со ссылкой на окно.
  const objIn = input.objects.find((o) => o.id === obj.id)!;
  const receipts = input.services.filter((s) => s.objectId === obj.id || (!s.objectId && obj.tenants.some((t) => activeTariff(s, t.id, month)))).map((s) => {
    const C = receiptCalcOf(input, objIn, s);
    if (s.config && C) {
      const cfg = s.config;
      const frame: FrameData = {
        id: s.id, name: s.name, supplier: s.supplier, cfg, C,
        values: Object.fromEntries(monthFields(cfg).map((f) => [f.key, f.key === cfg.billKey ? input.bills[obj.id]?.[s.id] : input.values?.[obj.id]?.[s.id]?.[f.key]])),
        readings: Object.fromEntries(obj.tenants.map((t) => [t.id, Object.fromEntries(cfg.lines.map((l) => [l.id, input.readings[t.id]?.[lineKey(s.id, l.id)]]))])),
      };
      return { s, frame, logic: 'share' as Method, M: METHODS.share, bill: undefined, active: true, noData: !C.ready, charged: 0, waited: false, shown: undefined };
    }
    const tr = obj.tenants.map((t) => activeTariff(s, t.id, month)).find(Boolean) ?? null;
    const logic = (tr?.logic ?? 'share') as Method;
    const M = METHODS[logic] ?? METHODS.share;
    const bill = input.bills[obj.id]?.[s.id];
    const lines = obj.tenants.flatMap((t) => res.tenants[t.id]?.lines.filter((l) => l.serviceId === s.id) ?? []);
    const noData = lines.some((l) => l.amount === null) || (M.bill && bill === undefined);
    const charged = sumMoney(lines.filter((l) => l.amount !== null).map((l) => l.amount as number));
    return {
      s, frame: null, logic, M, bill, active: !!tr, noData, charged,
      waited: M.bill && bill === undefined && prevBills[s.id] !== undefined,
      shown: M.bill ? bill : lines.length ? charged : undefined,
    };
  }).filter((r) => r.active);
  const missingReceipts = receipts.filter((r) => r.noData);

  const tenant = obj.tenants.find((t) => t.id === sp.t) ?? obj.tenants[0];
  const bill = tenant ? res.tenants[tenant.id] : null;
  const total = obj.tenants.reduce((a, t) => a + (res.tenants[t.id]?.total ?? 0), 0);
  const own = res.owner[obj.id];
  const ready = !missingReceipts.length && receipts.length > 0;
  const statusOf = (tid: string) => {
    const b = res.tenants[tid];
    if (!obj.isOwner && issued.has(tid)) return { text: 'Счёт выставлен', cls: 'bg-ok-soft text-ok' };
    if (!b || !b.serviceCount) return { text: 'Нет квитанций', cls: 'bg-[#eef0f3] text-[#4d5f71]' };
    if (b.missing.length) return { text: 'Не всё внесено', cls: 'bg-bad-soft text-bad' };
    return obj.isOwner ? { text: 'Внесено', cls: 'bg-ok-soft text-ok' } : { text: 'Готов к счёту', cls: 'bg-[#e8edf2] text-[#2c3e50]' };
  };

  // Проверка готовности перед выставлением счетов: что не так и куда нажать.
  const req = readRequisites(acc?.requisites, acc?.name ?? '');
  const noMail = obj.tenants.filter((t) => !t.email.trim());
  const firstMissing = missingReceipts[0];
  const checks: Array<{ ok: boolean; text: string; href?: string; act?: string }> = obj.isOwner ? [] : [
    receipts.length === 0
      ? { ok: false, text: 'Нет ни одной квитанции', href: `/objects/${obj.id}/receipt${q}`, act: 'Добавить' }
      : { ok: !missingReceipts.length, text: missingReceipts.length ? `Не внесено: ${missingReceipts.map((r) => r.s.name).join(', ')}` : 'Все квитанции внесены, суммы сходятся',
        href: firstMissing ? (firstMissing.frame ? `#r-${firstMissing.s.id}` : `/objects/${obj.id}/receipt${q}&s=${firstMissing.s.id}`) : undefined, act: 'Внести' },
    { ok: !noMail.length, text: noMail.length ? `Нет почты для счёта: ${noMail.map((t) => t.name).join(', ')}` : 'У всех арендаторов есть почта для счёта',
      href: `/objects/${obj.id}/edit`, act: 'Добавить' },
    { ok: !!(req.inn && (req.rs || req.sbp)), text: req.inn && (req.rs || req.sbp) ? 'Ваши реквизиты заполнены' : 'Заполните реквизиты: ИНН и куда платить', href: '/requisites', act: 'Заполнить' },
  ];
  const left = checks.filter((c) => !c.ok).length;

  const groups: Array<[string, BillLine[]]> = bill ? ([
    ['Общие', bill.lines.filter((l) => l.group === 'common')],
    ['Индивидуальные — по счётчикам', bill.lines.filter((l) => l.group === 'indiv')],
    ['Фиксированные', bill.lines.filter((l) => l.group === 'fixed')],
  ] as Array<[string, BillLine[]]>).filter(([, ls]) => ls.length) : [];

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <nav aria-label="Навигация" className="flex items-center gap-2 text-[24px] font-bold">
          <Link href={`/objects${q}`} className="text-accent hover:underline">Объекты</Link>
          <span className="text-faint">/</span><span>{obj.short}</span>
        </nav>
        <MonthNav month={month} path={`/objects/${obj.id}`} extra={tenant ? `&t=${tenant.id}` : ''} />
        <div className="flex-1" />
        <Link href={`/objects/${obj.id}/edit`} className="btn">Изменить объект</Link>
        <Link href={`/objects/${obj.id}/receipt${q}`} className="btn btn-primary"><Plus size={16} /> Квитанция</Link>
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
        {obj.isOwner ? (
          <>
            <Kpi label="За месяц — на вас" value={`${fmtMoney(total + (own?.total ?? 0))} ₽`} />
            <Kpi label="Квитанции" value={receipts.length ? `${receipts.length - missingReceipts.length} из ${receipts.length}` : 'нет'} note={receipts.length ? 'внесено' : ''} />
          </>
        ) : (
          <>
            <Kpi label="К выставлению" value={`${fmtMoney(total)} ₽`} />
            <Kpi label="Арендаторы" value={String(obj.tenants.length)} />
            <Kpi label="Квитанции" value={`${receipts.length - missingReceipts.length} из ${receipts.length}`} note="внесено" />
            <Kpi label="Остаётся на вас" value={`${fmtMoney(own?.total ?? 0)} ₽`} note={own?.lines.map((l) => l.label).join(', ') || 'нет расходов'} small />
          </>
        )}
      </div>

      {checks.length > 0 && (
        <section aria-label="Готовность счетов" className="card overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-[#f6f8fb] px-4 py-2.5">
            <span className="eyebrow">Готовность счетов · {monthLabel(month).toLowerCase()}</span>
            <span className={`pill ${left ? 'border border-cta/30 bg-warn-soft text-cta-ink' : 'bg-ok-soft text-ok'}`}>{left ? `Осталось шагов: ${left}` : 'Можно выставлять'}</span>
          </div>
          <div className="grid gap-2 p-3 md:grid-cols-3">
            {checks.map((c) => (
              <div key={c.text} className={`flex items-center gap-2.5 rounded-[10px] border px-3 py-2.5 ${c.ok ? 'border-ok/25 bg-ok-soft/50' : 'border-cta/35 bg-warn-soft'}`}>
                <span className={`flex size-6 flex-none items-center justify-center rounded-full bg-white ${c.ok ? 'text-ok' : 'text-cta-ink'}`}>{c.ok ? <Check size={14} /> : <CircleAlert size={14} />}</span>
                <span className="min-w-0 flex-1 text-[13px]">{c.text}</span>
                {!c.ok && c.href && <Link href={c.href} className="whitespace-nowrap text-[13px] font-semibold text-cta-ink hover:underline">{c.act} →</Link>}
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,1fr)]">
        {/* 1. Объект, арендаторы, счётчики */}
        <div className="flex flex-col gap-4">
          <section aria-label="Объект" className="card flex flex-col">
            <div className="flex gap-3 p-[18px]">
              <span className="flex size-10 flex-none items-center justify-center rounded-[10px] bg-accent-soft text-accent"><Building2 size={20} /></span>
              <span><b className="block text-[17px] font-semibold">{obj.short}</b><span className="hint">{obj.address || 'Адрес не указан'}</span></span>
            </div>
            <div className="border-t border-[#edf0f5] p-[18px]">
              <div className="eyebrow mb-2">{obj.isOwner ? 'Пользуется собственник' : `Арендаторы · ${obj.tenants.length}`}</div>
              <div className="flex flex-col gap-2">
                {obj.tenants.map((t) => {
                  const st = statusOf(t.id); const on = tenant?.id === t.id;
                  return (
                    <Link key={t.id} href={`/objects/${obj.id}${q}&t=${t.id}`} aria-current={on ? 'true' : undefined}
                      className={`rounded-[10px] border px-3.5 py-3 ${on ? 'border-2 border-accent bg-[#f2f5f8]' : 'border-line hover:border-line-strong'}`}>
                      <span className="flex items-baseline justify-between gap-2"><b className="truncate text-[15px] font-semibold">{t.name}</b>{!obj.isOwner && <span className="hint">доля {pctTxt(Number(t.share))}</span>}</span>
                      <span className="mt-1.5 flex items-center justify-between gap-2"><span className="font-semibold">{fmtMoney(res.tenants[t.id]?.total ?? 0)} ₽</span><span className={`pill ${st.cls}`}>{st.text}</span></span>
                    </Link>
                  );
                })}
              </div>
              {!obj.isOwner && <Link href={`/objects/${obj.id}/edit`} className="mt-2.5 block rounded-lg border border-dashed border-[#bcc5cf] px-2.5 py-2 font-semibold text-accent">+ Добавить арендатора</Link>}
            </div>
          </section>

          <section aria-label="Счётчики" className="card">
            <div className="flex items-center justify-between gap-2 p-[18px] pb-2">
              <span className="eyebrow">Счётчики · {meters.length}</span>
              <Link href={`/objects/${obj.id}/meter${q}`} className="text-[13px] font-semibold text-cta-ink hover:underline">+ Счётчик</Link>
            </div>
            {meters.length === 0 && <p className="hint px-[18px] pb-4">Добавьте счётчики объекта и арендаторов — номер будет подсказываться рядом с показаниями.</p>}
            <div className="flex flex-col pb-2">
              {meters.map((m) => {
                const R = RESOURCES[m.resource as Resource] ?? RESOURCES.other;
                const owner = m.tenantId ? obj.tenants.find((t) => t.id === m.tenantId)?.name ?? '—' : 'Общий на объект';
                const late = m.verifyUntil && m.verifyUntil < `${month}-31`;
                return (
                  <Link key={m.id} href={`/objects/${obj.id}/meter${q}&id=${m.id}`} className="flex items-center gap-3 border-t border-[#f0f2f6] px-[18px] py-2.5 hover:bg-[#f8fafc]">
                    <span className="flex size-8 flex-none items-center justify-center rounded-[8px] bg-accent-soft text-accent"><KindIcon name={R.icon} size={16} /></span>
                    <span className="min-w-0 flex-1"><b className="block truncate font-semibold">{R.label}{m.dayNight ? ' · день/ночь' : ''}</b>
                      <span className="hint block truncate">{obj.isOwner && m.tenantId ? 'свой' : owner} · № {m.number || '—'}</span></span>
                    {late && <span className="pill bg-bad-soft text-bad">поверка</span>}
                  </Link>
                );
              })}
            </div>
          </section>
        </div>

        {/* 2. Квитанции месяца */}
        <section aria-label="Квитанции" className="card flex flex-col">
          <div className="flex items-start justify-between gap-2 p-[18px] pb-2">
            <div><div className="eyebrow">Квитанции · {monthLabel(month).toLowerCase()}</div>
              <div className="mt-1 text-[16px] font-bold">{receipts.length ? `${receipts.length - missingReceipts.length} из ${receipts.length} внесено` : 'Пока нет'}</div></div>
            {receipts.length > 0 && <span className={`pill ${ready ? 'bg-ok-soft text-ok' : 'bg-bad-soft text-bad'}`}>{ready ? 'Всё внесено' : 'Не всё внесено'}</span>}
          </div>
          <div className="flex flex-col gap-2 px-[18px] pb-3">
            {receipts.length === 0 && (
              <p className="rounded-[10px] border border-dashed border-[#c9d1da] p-3.5 text-ink-2">
                Добавьте квитанции, которые приходят на объект: электричество, вода, УК… Для каждой один раз выбираете, как делить, — дальше каждый месяц только сумма и показания.
              </p>
            )}
            {receipts.length > 0 && <p className="hint text-[13px]">Введите суммы и показания за месяц — расчёт справа посчитается сам</p>}
            {receipts.map((r) => {
              if (r.frame) return <ReceiptFrame key={r.s.id} f={r.frame} objectId={obj.id} month={month} tenants={obj.tenants.map((t) => ({ id: t.id, name: obj.isOwner ? 'Вы (собственник)' : t.name }))} />;
              const c = category(r.s.category ?? '');
              return (
                <Link key={r.s.id} id={`r-${r.s.id}`} href={`/objects/${obj.id}/receipt${q}&s=${r.s.id}`}
                  className={`flex items-center gap-3 rounded-[10px] border px-3 py-2.5 hover:border-cta ${r.noData ? 'border-dashed border-[#bcc5cf]' : 'border-line'}`}>
                  <span className={`flex size-8 flex-none items-center justify-center rounded-[8px] ${r.noData ? 'bg-[#eef1f4] text-faint' : 'bg-cta-soft text-cta-ink'}`}><KindIcon name={c.icon} size={16} /></span>
                  <span className="min-w-0 flex-1"><b className="block truncate font-semibold">{r.s.name}</b>
                    <span className="hint block truncate">{r.s.supplier} · {r.M.label.toLowerCase()}</span>
                    <span className="block truncate text-[11px] text-cta-ink">заведена по-старому — откройте, чтобы разложить по строкам</span></span>
                  {r.noData ? (
                    <span className="flex flex-col items-end"><span className="text-[13px] font-semibold text-cta-ink">Внести</span>
                      <span className="text-[11px] text-muted">{r.waited ? 'была в прошлом месяце' : r.M.bill && r.bill === undefined ? 'нет суммы' : 'нет показаний'}</span></span>
                  ) : (
                    <span className="flex flex-col items-end"><span className="whitespace-nowrap font-semibold">{r.shown === undefined ? '—' : fmtMoney(r.shown)}</span>
                      <span className="flex items-center gap-0.5 text-[11px] font-semibold text-ok"><Check size={12} />{r.M.bill ? 'сходится' : 'по счётчикам'}</span></span>
                  )}
                </Link>
              );
            })}
          </div>
          <div className="mt-auto border-t border-line px-[18px] py-3.5">
            <Link href={`/objects/${obj.id}/receipt${q}`} className="btn btn-primary w-full"><Plus size={16} /> Добавить квитанцию</Link>
          </div>
        </section>

        {/* 3. Расчёт по выбранному арендатору */}
        {bill && tenant ? (
          <section aria-label="Расчёт" className="card flex flex-col">
            <div className="flex items-start justify-between gap-2 p-[18px] pb-2">
              <div><div className="eyebrow">Расчёт</div><div className="mt-1 text-[16px] font-bold">{tenant.name}</div></div>
              <span className={`pill ${statusOf(tenant.id).cls}`}>{statusOf(tenant.id).text}</span>
            </div>
            <div className="flex flex-col gap-3 px-[18px] pb-4">
              {groups.length === 0 && <p className="hint">Квитанций для расчёта пока нет.</p>}
              {groups.map(([title, ls]) => (
                <div key={title} className="overflow-hidden rounded-[10px] border border-[#e6eaee]">
                  <div className="flex justify-between bg-[#f3f5f9] px-3 py-2 font-semibold"><span>{title}</span><span>{fmtMoney(ls.reduce((a, l) => a + (l.amount ?? 0), 0))}</span></div>
                  {ls.map((l, i) => (
                    <div key={i} className="flex justify-between gap-3 border-t border-[#f0f2f6] px-3 py-2">
                      <span className="min-w-0"><span className="block">{l.label}</span>
                        {l.formula !== 'фиксированная сумма' && <span className="block text-[12px] text-muted">{l.formula}</span>}
                        {l.note && <span className="block text-[12px] text-faint">{l.note}</span>}</span>
                      <span className="whitespace-nowrap font-semibold">{l.amount === null ? '—' : fmtMoney(l.amount)}</span>
                    </div>
                  ))}
                </div>
              ))}
              <div className="mt-1 flex items-baseline justify-between border-t-2 border-nav pt-2.5">
                <b className="font-bold">{obj.isOwner ? 'Итого за месяц' : 'Итого к оплате'}</b><span className="text-[22px] font-bold">{fmtMoney(bill.total)} ₽</span>
              </div>
              <div className="hint">{rubWords(bill.total)}. Без НДС.</div>
            </div>
            <div className="mt-auto flex flex-wrap gap-2 border-t border-line px-[18px] py-3.5">
              <Link href={`/report/${tenant.id}${q}`} target="_blank" className="btn btn-primary"><FileText size={16} /> Отчёт PDF</Link>
              {obj.isOwner ? null : issued.has(tenant.id) ? <Link href="/bills/issued" className="btn">Счёт выставлен →</Link> : <Link href={`/bills${q}`} className="btn">К выставлению →</Link>}
            </div>
          </section>
        ) : <section className="card p-[18px] text-ink-2">Добавьте арендатора, чтобы считать его долю.</section>}
      </div>
    </>
  );
}

function Kpi({ label, value, note, small }: { label: string; value: string; note?: string; small?: boolean }) {
  return (
    <div className="card px-4 py-3.5">
      <div className="text-[12px] text-muted">{label}</div>
      <div className="mt-0.5 text-[22px] font-bold">{value} {note && !small && <span className="text-[13px] font-medium text-muted">{note}</span>}</div>
      {note && small && <div className="hint truncate">{note}</div>}
    </div>
  );
}
