/**
 * Квитанции из строк (окно-конструктор): 10 примеров из задания, как в «Сверке» макета
 * docs/mockups/receipt-constructor-mockup.html. Королёва 61: Виктор 45%, Владислав 55%; Ленина 20: Олег 60%.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateMonth } from '../src/lib/calc/engine.ts';
import { billKeyOf, calcReceipt, monthFields, splitKop } from '../src/lib/calc/lines.ts';
import { sumMoney } from '../src/lib/calc/format.ts';
import type { MonthInput, ReceiptConfig, ReceiptLine, Service } from '../src/lib/calc/types.ts';

const line = (o: Partial<ReceiptLine> & { q: ReceiptLine['q'] }): ReceiptLine =>
  ({ id: '', sign: 1, name: '', unit: '₽', t: { mode: 'set' }, ...o });
const cfg = (lines: ReceiptLine[], pay: Partial<ReceiptConfig['pay']> = {}, coef = 1): ReceiptConfig =>
  ({ lines, pay: { mode: 'shares', vacant: true, rest: 'none', base: 'qty', off: [], ...pay }, coef });
const svc = (id: string, objectId: string, name: string, config: ReceiptConfig): Service =>
  ({ id, objectId, supplier: '', name, unit: config.lines[0].unit, kind: 'common', tariffs: [], config: { ...config, billKey: billKeyOf(config) } });

const services: Service[] = [
  svc('c1', 'k61', 'Содержание и ремонт', cfg([line({ q: { src: 'month' } })])),
  svc('c2', 'k61', 'Вывоз мусора', cfg([line({ q: { src: 'month' } })], { mode: 'equal' })),
  svc('c3', 'k61', 'Охрана', cfg([line({ q: { src: 'const', v: 2000 } })])),
  svc('c4', 'k61', 'Электричество', cfg([line({ unit: 'кВт·ч', q: { src: 'each', read: 'diff' }, t: { mode: 'set', p: 6.5 } })])),
  svc('c5', 'k61', 'Эл. день/ночь', cfg([
    line({ name: 'день', unit: 'кВт·ч', q: { src: 'each', read: 'direct' }, t: { mode: 'set', p: 7.2 } }),
    line({ id: 'L2', name: 'ночь', unit: 'кВт·ч', q: { src: 'each', read: 'direct' }, t: { mode: 'set', p: 3.1 } })])),
  svc('c6', 'k61', 'Вода холодная', cfg([line({ unit: 'м³', q: { src: 'each', read: 'direct' }, t: { mode: 'sum' } })])),
  svc('c7', 'k61', 'ТЭК гор. вода', cfg([
    line({ name: 'вода', unit: 'м³', q: { src: 'each', read: 'direct' }, t: { mode: 'set', p: 67.98 } }),
    line({ id: 'L2', name: 'подогрев', unit: 'Гкал', q: { src: 'norm', k: 0.06, ref: '' }, t: { mode: 'set', p: 4628.57 } })],
  { rest: 'shares', base: 'qty', baseLine: 'L2' })),
  svc('c8', 'k61', 'Водоотведение', cfg([line({ unit: 'м³', q: { src: 'sum', srcs: ['c6', 'c7'] }, t: { mode: 'set', p: 45 } })])),
  svc('c9', 'k61', 'Благоустройство', cfg([
    line({ unit: 'м²', q: { src: 'const', v: 45 }, t: { mode: 'set', p: 36.4 } }),
    line({ id: 'L2', name: 'скидка', sign: -1, q: { src: 'const', v: 300 } }),
    line({ id: 'L3', name: 'ТСЖ', q: { src: 'month' } })])),
  svc('c10', 'l20', 'Содержание и ремонт', cfg([line({ q: { src: 'month' } })])),
];

const sept: MonthInput = {
  month: '2026-09',
  objects: [
    { id: 'k61', name: 'Королева 61', tenants: [{ id: 'V', name: 'Виктор «Эгоист»', share: 45 }, { id: 'W', name: 'Владислав «Кофе»', share: 55 }] },
    { id: 'l20', name: 'Ленина 20', tenants: [{ id: 'O', name: 'Олег «Цветы»', share: 60 }] },
  ],
  services,
  // Главная сумма квитанции (billKey) — в суммах счетов на помещение.
  bills: { k61: { c1: 4200, c2: 600, c6: 1200, c9: 420 }, l20: { c10: 4200 } },
  values: { k61: { c7: { qty: 0.44 } } },
  readings: {
    V: { c4: { prev: 1000, cur: 1120 }, c5: { usage: 90 }, 'c5:L2': { usage: 30 }, c6: { usage: 3 }, c7: { usage: 3 } },
    W: { c4: { prev: 500, cur: 580 }, c5: { usage: 60 }, 'c5:L2': { usage: 20 }, c6: { usage: 1 }, c7: { usage: 1 } },
  },
};

const res = calculateMonth(sept);
const of = (tid: string, sid: string) => sumMoney(res.tenants[tid].lines.filter((l) => l.serviceId === sid).map((l) => l.amount ?? NaN));
const mine = (oid: string, sid: string) => res.owner[oid].lines.find((l) => l.serviceId === sid)?.amount ?? 0;

const EXAMPLES: Array<[number, string, number, number, number]> = [
  [1, 'c1', 1890, 2310, 0],
  [2, 'c2', 300, 300, 0],
  [3, 'c3', 900, 1100, 0],
  [4, 'c4', 780, 520, 0],
  [5, 'c5', 741, 494, 0],
  [6, 'c6', 900, 300, 0],
  [7, 'c7', 1453.65, 854.84, 0],
  // В таблице задания 360 / 135 (объём 8 и 3 м³). Из примеров 6 и 7 выходит хол. 3 + гор. 3 = 6 м³ и 1 + 1 = 2 м³.
  [8, 'c8', 270, 90, 0],
  [9, 'c9', 791.10, 966.90, 0],
];

for (const [n, sid, v, w, m] of EXAMPLES) {
  test(`пример ${n}: ${services.find((s) => s.id === sid)!.name}`, () => {
    assert.equal(of('V', sid), v, 'Виктор');
    assert.equal(of('W', sid), w, 'Владислав');
    assert.equal(mine('k61', sid), m, 'на вас');
  });
}

test('пример 10: Ленина 20, сдано 60% — пустующие 40% на вас', () => {
  assert.equal(of('O', 'c10'), 2520);
  assert.equal(mine('l20', 'c10'), 1680);
});

test('общее делится до копейки: сумма частей = сумма квитанции', () => {
  assert.deepEqual(splitKop(1000.01, [1, 1]), [500.01, 500]);
  assert.equal(sumMoney(splitKop(925.72, [45, 55])), 925.72);
});

test('итог арендатора = сумма строк, все примеры готовы', () => {
  for (const t of ['V', 'W', 'O']) {
    const b = res.tenants[t];
    assert.deepEqual(b.missing, []);
    assert.equal(b.total, sumMoney(b.lines.map((l) => l.amount ?? 0)));
  }
});

test('нет показаний — квитанция ждёт, строка без суммы', () => {
  const input: MonthInput = structuredClone(sept);
  delete input.readings.W.c4;
  const r = calculateMonth(input);
  assert.equal(r.tenants.W.lines.find((l) => l.serviceId === 'c4')?.amount, null);
  assert.ok(r.tenants.W.missing.some((x) => x.startsWith('Электричество: ждём показания')));
  assert.equal(r.tenants.V.lines.find((l) => l.serviceId === 'c4')?.amount, null, 'пока не сошлось — не считаем и Виктору');
});

test('кто платит сам: в счёт не идёт, его доля общего — на вас; показания его не нужны', () => {
  const input: MonthInput = structuredClone(sept);
  input.services = input.services.map((s) => (s.id === 'c1' || s.id === 'c4' ? { ...s, config: { ...s.config!, pay: { ...s.config!.pay, off: ['W'] } } } : s));
  delete input.readings.W.c4;
  const r = calculateMonth(input);
  assert.equal(r.tenants.W.lines.some((l) => l.serviceId === 'c1' || l.serviceId === 'c4'), false);
  assert.equal(of2(r, 'V', 'c1'), 1890);
  assert.equal(r.owner.k61.lines.find((l) => l.serviceId === 'c1')?.amount, 2310);
  assert.equal(of2(r, 'V', 'c4'), 780);
  assert.equal(r.owner.k61.lines.some((l) => l.serviceId === 'c4'), false, 'по своему счётчику на вас не начисляем');
});
const of2 = (r: ReturnType<typeof calculateMonth>, tid: string, sid: string) => sumMoney(r.tenants[tid].lines.filter((l) => l.serviceId === sid).map((l) => l.amount ?? NaN));

test('«поровну» — только между теми, кто платит: мусор у одного арендатора целиком на нём', () => {
  const input: MonthInput = structuredClone(sept);
  input.services = input.services.map((s) => (s.id === 'c2' ? { ...s, config: { ...s.config!, pay: { ...s.config!.pay, off: ['V'] } } } : s));
  const r = calculateMonth(input);
  assert.equal(of2(r, 'W', 'c2'), 600);
  assert.equal(r.owner.k61.lines.some((l) => l.serviceId === 'c2'), false);
  // Никто не платит — вся сумма на вас.
  input.services = input.services.map((s) => (s.id === 'c2' ? { ...s, config: { ...s.config!, pay: { ...s.config!.pay, off: ['V', 'W'] } } } : s));
  assert.equal(calculateMonth(input).owner.k61.lines.find((l) => l.serviceId === 'c2')?.amount, 600);
});

test('коэффициент: каждая строка × 1,06 до копеек', () => {
  const input: MonthInput = structuredClone(sept);
  input.services = input.services.map((s) => (s.id === 'c9' ? { ...s, config: { ...s.config!, coef: 1.06 } } : s));
  const r = calculateMonth(input);
  // 737,10 × 1,06 − 135 × 1,06 + 189 × 1,06 = 781,33 − 143,10 + 200,34
  assert.equal(of2(r, 'V', 'c9'), 838.57);
});

test('общий счётчик: тариф = сумма ÷ общий расход, разница — на вас', () => {
  const c = cfg([line({ unit: 'м³', q: { src: 'each', read: 'direct' }, t: { mode: 'sum', common: true } })]);
  const C = calcReceipt(c, {
    tenants: sept.objects[0].tenants,
    value: (k) => ({ ':money': 1200, ':camt': 5 } as Record<string, number>)[k],
    reading: (tid) => ({ usage: tid === 'V' ? 3 : 1 }),
    source: () => undefined, sourceName: () => '',
  });
  assert.equal(C.ready, true);
  assert.deepEqual([C.per.V[0].sum, C.per.W[0].sum, C.mine], [720, 240, 240]);
});

test('месячные поля рамки и главная сумма квитанции', () => {
  const c7 = services.find((s) => s.id === 'c7')!.config!;
  assert.deepEqual(monthFields(c7).map((f) => f.key), ['qty']);
  assert.equal(services.find((s) => s.id === 'c1')!.config!.billKey, ':v');
  assert.equal(services.find((s) => s.id === 'c6')!.config!.billKey, ':money');
  assert.equal(c7.billKey, undefined);
  const c9 = services.find((s) => s.id === 'c9')!.config!;
  assert.deepEqual(monthFields(c9).map((f) => f.key), ['L3:v']);
  assert.equal(c9.billKey, 'L3:v');
});

test('старая квитанция «от других услуг» берёт расход и из квитанций из строк', () => {
  const input: MonthInput = structuredClone(sept);
  input.services.push({ id: 'old-dr', objectId: 'k61', supplier: 'Водоканал', name: 'Водоотведение (старое)', unit: 'м³', kind: 'indiv',
    tariffs: [{ logic: 'derived', price: 45, sources: ['c6', 'c7'], who: 'all', from: '2026-01-01' }] });
  const r = calculateMonth(input);
  assert.equal(r.tenants.V.lines.find((l) => l.serviceId === 'old-dr')?.amount, 270); // (3 + 3) м³ × 45
  assert.equal(r.tenants.W.lines.find((l) => l.serviceId === 'old-dr')?.amount, 90);
});

test('объект собственника без арендаторов: вся квитанция на вас', () => {
  const C = calcReceipt(cfg([line({ q: { src: 'month' } })]), {
    tenants: [], value: () => 980, reading: () => undefined, source: () => undefined, sourceName: () => '',
  });
  assert.equal(C.ready, true);
  assert.equal(C.mine, 980);
});
