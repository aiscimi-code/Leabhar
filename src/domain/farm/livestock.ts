import { and, asc, desc, eq, lte, sql } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  accounts, animalGroups, animals, companies, invoiceLines, invoices, livestockEvents, livestockValuations, LIVESTOCK_SPECIES,
  type LivestockValuationLine,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { asIsoDate, type IsoDate } from '../dates';
import { atomically, assertAccountingPeriodOpen, postJournalEntry } from '../accounting/journal';
import { accountBalance } from '../accounting/ledger';
import { upsertReviewItem } from '../extraction/service';
import { FarmError, requireEnterprise, requireFarmDate } from './setup';

/**
 * The livestock register (EPIC 24, issue #540): animal groups, tagged
 * animals, and an immutable register of events (opening, purchase, sale,
 * birth, death, transfer between groups, reversal). Every recording path
 * checks the whole register inside its transaction: a group's head count
 * never goes below nil on any date, and a tagged animal is only sold, lost or
 * moved while it is on the farm.
 *
 * A valuation is head count by group times the value per head the person
 * gives, with its basis. The book computes no deemed-cost percentage. Posting
 * one moves the change since the last posted valuation between each group's
 * stock and change-in-value accounts, like closing stock (ADR 0015).
 */

export type AnimalGroup = typeof animalGroups.$inferSelect;
export type Animal = typeof animals.$inferSelect;
export type LivestockEvent = typeof livestockEvents.$inferSelect;
export type Species = (typeof LIVESTOCK_SPECIES)[number];

function accountByCode(db: AppDatabase, companyId: string, code: string, what: string): string {
  const row = db.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.companyId, companyId), eq(accounts.code, code))).get();
  if (!row) throw new FarmError(`This book has no ${code} account (the farm chart's ${what}): name the account for the group.`);
  return row.id;
}

function requireAccount(db: AppDatabase, companyId: string, accountId: string, type: 'asset' | 'expense') {
  const a = db.select().from(accounts).where(and(eq(accounts.id, accountId), eq(accounts.companyId, companyId))).get();
  if (!a) throw new FarmError(`Account ${accountId} not found.`);
  if (a.type !== type) throw new FarmError(`${a.code} ${a.name} is not an ${type} account.`);
  return a;
}

export function createAnimalGroup(db: AppDatabase, p: {
  companyId: string; enterpriseId: string; name: string; species: Species; stockAccountId?: string; changeAccountId?: string;
  recordedBy: string;
}): AnimalGroup {
  const enterprise = requireEnterprise(db, p.companyId, p.enterpriseId);
  const name = p.name.trim();
  if (!name) throw new FarmError('Give the group a name (for example "Dairy cows" or "Weanlings").');
  if (!LIVESTOCK_SPECIES.includes(p.species)) throw new FarmError(`The species is one of: ${LIVESTOCK_SPECIES.join(', ')}.`);
  const stockAccountId = p.stockAccountId ?? accountByCode(db, p.companyId, '1330', 'Livestock on hand');
  const changeAccountId = p.changeAccountId ?? accountByCode(db, p.companyId, '5040', 'Livestock purchases');
  requireAccount(db, p.companyId, stockAccountId, 'asset');
  requireAccount(db, p.companyId, changeAccountId, 'expense');
  const clash = db.select({ id: animalGroups.id }).from(animalGroups)
    .where(and(eq(animalGroups.companyId, p.companyId), eq(animalGroups.name, name))).get();
  if (clash) throw new FarmError(`There is already a group called ${name}.`);
  const id = ids.animalGroup();
  db.insert(animalGroups).values({
    id, companyId: p.companyId, enterpriseId: enterprise.id, name, species: p.species, stockAccountId, changeAccountId, recordedBy: p.recordedBy,
  }).run();
  return db.select().from(animalGroups).where(eq(animalGroups.id, id)).get()!;
}

export function requireGroup(db: AppDatabase, companyId: string, idOrName: string): AnimalGroup {
  const g = db.select().from(animalGroups).where(and(eq(animalGroups.companyId, companyId), eq(animalGroups.id, idOrName))).get()
    ?? db.select().from(animalGroups).where(and(eq(animalGroups.companyId, companyId), eq(animalGroups.name, idOrName))).get();
  if (!g) throw new FarmError(`Animal group ${idOrName} not found.`);
  return g;
}

export function listAnimalGroups(db: AppDatabase, companyId: string): AnimalGroup[] {
  return db.select().from(animalGroups).where(eq(animalGroups.companyId, companyId)).orderBy(asc(animalGroups.name)).all();
}

export function registerAnimal(db: AppDatabase, p: {
  companyId: string; tagNumber: string; species: Species; sex?: Animal['sex']; breed?: string | null; dateOfBirth?: string | null;
  damTag?: string | null; recordedBy: string;
}): Animal {
  const tag = p.tagNumber.trim().toUpperCase();
  if (!tag) throw new FarmError('Give the animal\'s tag number.');
  if (!LIVESTOCK_SPECIES.includes(p.species)) throw new FarmError(`The species is one of: ${LIVESTOCK_SPECIES.join(', ')}.`);
  const clash = db.select({ id: animals.id }).from(animals).where(and(eq(animals.companyId, p.companyId), eq(animals.tagNumber, tag))).get();
  if (clash) throw new FarmError(`Tag ${tag} is already registered.`);
  const id = ids.animal();
  db.insert(animals).values({
    id, companyId: p.companyId, tagNumber: tag, species: p.species, sex: p.sex ?? null, breed: p.breed?.trim() || null,
    dateOfBirth: p.dateOfBirth ? requireFarmDate(p.dateOfBirth, 'The date of birth') : null, damTag: p.damTag?.trim().toUpperCase() || null,
    recordedBy: p.recordedBy,
  }).run();
  return db.select().from(animals).where(eq(animals.id, id)).get()!;
}

export function requireAnimal(db: AppDatabase, companyId: string, idOrTag: string): Animal {
  const a = db.select().from(animals).where(and(eq(animals.companyId, companyId), eq(animals.id, idOrTag))).get()
    ?? db.select().from(animals).where(and(eq(animals.companyId, companyId), eq(animals.tagNumber, idOrTag.trim().toUpperCase()))).get();
  if (!a) throw new FarmError(`Animal ${idOrTag} not found.`);
  return a;
}

export function listAnimals(db: AppDatabase, companyId: string) {
  return db.select().from(animals).where(eq(animals.companyId, companyId)).orderBy(asc(animals.tagNumber)).all()
    .map((a) => ({ ...a, ...animalStatus(db, a.id) }));
}

const IN_KINDS = new Set(['opening', 'purchase', 'birth', 'transfer_in']);
const OUT_KINDS = new Set(['sale', 'death', 'transfer_out']);

function eventsInOrder(db: AppDatabase, where: ReturnType<typeof eq>) {
  return db.select().from(livestockEvents).where(where).orderBy(asc(livestockEvents.eventDate), asc(livestockEvents.sequence)).all();
}

/** Where a tagged animal is: its group while on the farm, null once gone or before it arrives. */
export function animalStatus(db: AppDatabase, animalId: string, asOf?: string): { groupId: string | null; onFarm: boolean } {
  let groupId: string | null = null;
  for (const e of eventsInOrder(db, eq(livestockEvents.animalId, animalId))) {
    if (asOf && e.eventDate > asOf) break;
    groupId = e.headCount > 0 ? e.groupId : null;
  }
  return { groupId, onFarm: groupId !== null };
}

/** Replay the register: refuse a group below nil, or a tagged animal moving when it is not where the event says. */
function checkRegister(db: AppDatabase, _companyId: string, groupIds: string[], animalId: string | null) {
  if (animalId) {
    let at: string | null = null;
    const tag = db.select().from(animals).where(eq(animals.id, animalId)).get()!.tagNumber;
    for (const e of eventsInOrder(db, eq(livestockEvents.animalId, animalId))) {
      if (e.headCount > 0) {
        if (at) throw new FarmError(`${tag} is already on the farm on ${e.eventDate}.`);
        at = e.groupId;
      } else {
        if (at !== e.groupId) throw new FarmError(`${tag} is not in that group on ${e.eventDate}.`);
        at = null;
      }
    }
  }
  for (const groupId of groupIds) {
    let count = 0;
    for (const e of eventsInOrder(db, eq(livestockEvents.groupId, groupId))) {
      count += e.headCount;
      if (count < 0) {
        const g = db.select().from(animalGroups).where(eq(animalGroups.id, groupId)).get()!;
        throw new FarmError(`${g.name} would have ${count} head on ${e.eventDate}: a group cannot go below nil on any date.`);
      }
    }
  }
}

export function assertAfterLastLivestockValuation(db: AppDatabase, companyId: string, date: string) {
  const last = db.select({ d: livestockValuations.valuationDate }).from(livestockValuations)
    .where(eq(livestockValuations.companyId, companyId)).orderBy(desc(livestockValuations.valuationDate)).get();
  if (last && date <= last.d) throw new FarmError(`Livestock was valued at ${last.d}: record the event after that date.`);
}

function nextSequence(db: AppDatabase, companyId: string): number {
  return db.select({ n: sql<number>`coalesce(max(${livestockEvents.sequence}), 0)` }).from(livestockEvents)
    .where(eq(livestockEvents.companyId, companyId)).get()!.n + 1;
}

function insertEvent(db: AppDatabase, e: Omit<typeof livestockEvents.$inferInsert, 'id' | 'sequence'> & { id?: string }): string {
  const id = e.id ?? ids.livestockEvent();
  db.insert(livestockEvents).values({ ...e, id, sequence: nextSequence(db, e.companyId) }).run();
  return id;
}

export type SimpleEventKind = 'opening' | 'purchase' | 'sale' | 'birth' | 'death';

/**
 * Record an opening count, a purchase, a sale, a birth or a death (issue
 * #540): a head count for a group, or one tagged animal. A death needs its
 * cause. A purchase or sale may name its invoice line.
 */
export function recordLivestockEvent(db: AppDatabase, p: {
  companyId: string; kind: SimpleEventKind; groupId: string; date: string; headCount?: number; animalId?: string | null;
  amountMinor?: number | null; invoiceLineId?: string | null; reason?: string | null; recordedBy: string;
}): LivestockEvent {
  return atomically(db, () => {
    const group = requireGroup(db, p.companyId, p.groupId);
    const date = requireFarmDate(p.date, 'The date');
    assertAfterLastLivestockValuation(db, p.companyId, date);
    const animal = p.animalId ? requireAnimal(db, p.companyId, p.animalId) : null;
    if (animal && animal.species !== group.species) throw new FarmError(`${animal.tagNumber} is ${animal.species}; ${group.name} holds ${group.species}.`);
    const head = animal ? 1 : p.headCount;
    if (!head || !Number.isInteger(head) || head <= 0) throw new FarmError('The head count is a positive whole number.');
    if (p.kind === 'death' && !p.reason?.trim()) throw new FarmError('Record the cause of death.');
    if (p.amountMinor !== undefined && p.amountMinor !== null && (!Number.isInteger(p.amountMinor) || p.amountMinor < 0)) {
      throw new FarmError('The amount is a whole number of minor units.');
    }
    if (p.invoiceLineId) {
      if (p.kind !== 'purchase' && p.kind !== 'sale') throw new FarmError('Only a purchase or a sale has an invoice line.');
      const line = db.select({ direction: invoices.direction, status: invoices.status }).from(invoiceLines)
        .innerJoin(invoices, eq(invoiceLines.invoiceId, invoices.id))
        .where(and(eq(invoiceLines.id, p.invoiceLineId), eq(invoiceLines.companyId, p.companyId))).get();
      if (!line) throw new FarmError(`Invoice line ${p.invoiceLineId} not found.`);
      if (line.direction !== (p.kind === 'purchase' ? 'purchase' : 'sales')) throw new FarmError(`That line is on a ${line.direction} invoice.`);
      if (line.status === 'draft' || line.status === 'void') throw new FarmError(`That invoice is ${line.status}.`);
    }
    if (animal && p.kind === 'birth' && animal.dateOfBirth && animal.dateOfBirth !== date) {
      throw new FarmError(`${animal.tagNumber} was born on ${animal.dateOfBirth}.`);
    }
    const id = insertEvent(db, {
      companyId: p.companyId, groupId: group.id, animalId: animal?.id ?? null, eventDate: date, kind: p.kind,
      headCount: OUT_KINDS.has(p.kind) ? -head : head, amountMinor: p.amountMinor ?? null, invoiceLineId: p.invoiceLineId ?? null,
      reason: p.reason?.trim() || null, recordedBy: p.recordedBy,
    });
    checkRegister(db, p.companyId, [group.id], animal?.id ?? null);
    return db.select().from(livestockEvents).where(eq(livestockEvents.id, id)).get()!;
  });
}

/** Move animals between groups (issue #540): calves to weanlings, heifers into the herd. */
export function transferLivestock(db: AppDatabase, p: {
  companyId: string; fromGroupId: string; toGroupId: string; date: string; headCount?: number; animalId?: string | null;
  reason?: string | null; recordedBy: string;
}): { out: LivestockEvent; in: LivestockEvent } {
  return atomically(db, () => {
    const from = requireGroup(db, p.companyId, p.fromGroupId);
    const to = requireGroup(db, p.companyId, p.toGroupId);
    if (from.id === to.id) throw new FarmError('A transfer moves animals to a different group.');
    if (from.species !== to.species) throw new FarmError(`${from.name} holds ${from.species}; ${to.name} holds ${to.species}.`);
    const date = requireFarmDate(p.date, 'The date');
    assertAfterLastLivestockValuation(db, p.companyId, date);
    const animal = p.animalId ? requireAnimal(db, p.companyId, p.animalId) : null;
    const head = animal ? 1 : p.headCount;
    if (!head || !Number.isInteger(head) || head <= 0) throw new FarmError('The head count is a positive whole number.');
    const outId = ids.livestockEvent();
    const inId = ids.livestockEvent();
    const common = { companyId: p.companyId, animalId: animal?.id ?? null, eventDate: date, reason: p.reason?.trim() || null, recordedBy: p.recordedBy };
    insertEvent(db, { ...common, id: outId, groupId: from.id, kind: 'transfer_out', headCount: -head, transferPairId: inId });
    insertEvent(db, { ...common, id: inId, groupId: to.id, kind: 'transfer_in', headCount: head, transferPairId: outId });
    checkRegister(db, p.companyId, [from.id, to.id], animal?.id ?? null);
    const load = (id: string) => db.select().from(livestockEvents).where(eq(livestockEvents.id, id)).get()!;
    return { out: load(outId), in: load(inId) };
  });
}

/** Correct a mistaken event by reversing it; a transfer is reversed as a pair. The original stays. */
export function reverseLivestockEvent(db: AppDatabase, p: {
  companyId: string; eventId: string; date: string; reason: string; recordedBy: string;
}): LivestockEvent[] {
  return atomically(db, () => {
    const original = db.select().from(livestockEvents)
      .where(and(eq(livestockEvents.id, p.eventId), eq(livestockEvents.companyId, p.companyId))).get();
    if (!original) throw new FarmError(`Livestock event ${p.eventId} not found.`);
    if (original.kind === 'reversal') throw new FarmError('A reversal is not reversed: record the event again.');
    if (!p.reason.trim()) throw new FarmError('Give the reason for the reversal.');
    const date = requireFarmDate(p.date, 'The date');
    if (date < original.eventDate) throw new FarmError('A reversal is dated on or after the event it reverses.');
    assertAfterLastLivestockValuation(db, p.companyId, date);
    const pair = original.transferPairId
      ? db.select().from(livestockEvents).where(eq(livestockEvents.id, original.transferPairId)).get()!
      : null;
    const targets = pair ? [original, pair] : [original];
    for (const t of targets) {
      const done = db.select({ id: livestockEvents.id }).from(livestockEvents)
        .where(and(eq(livestockEvents.relatedEventId, t.id), eq(livestockEvents.kind, 'reversal'))).get();
      if (done) throw new FarmError(`Event ${t.id} has already been reversed.`);
    }
    // Undo the in half of a transfer first, so the animal is back where it came from.
    const ordered = targets.sort((a, b) => b.headCount - a.headCount);
    const made = ordered.map((t) => insertEvent(db, {
      companyId: p.companyId, groupId: t.groupId, animalId: t.animalId, eventDate: date, kind: 'reversal', headCount: -t.headCount,
      relatedEventId: t.id, reason: p.reason.trim(), recordedBy: p.recordedBy,
    }));
    checkRegister(db, p.companyId, [...new Set(targets.map((t) => t.groupId))], original.animalId);
    return made.map((id) => db.select().from(livestockEvents).where(eq(livestockEvents.id, id)).get()!);
  });
}

/** Head count by group on a date. */
export function headCounts(db: AppDatabase, p: { companyId: string; asOf: string }): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of db.select().from(livestockEvents)
    .where(and(eq(livestockEvents.companyId, p.companyId), lte(livestockEvents.eventDate, p.asOf))).all()) {
    out.set(e.groupId, (out.get(e.groupId) ?? 0) + e.headCount);
  }
  return out;
}

export function listLivestockEvents(db: AppDatabase, companyId: string): LivestockEvent[] {
  return db.select().from(livestockEvents).where(eq(livestockEvents.companyId, companyId))
    .orderBy(desc(livestockEvents.eventDate), desc(livestockEvents.sequence)).all();
}

export interface LivestockValuationPlan {
  date: IsoDate;
  opening: boolean;
  lines: Array<LivestockValuationLine & { name: string; previousMinor: number }>;
  valueMinor: number;
  stockAccounts: Array<{ accountId: string; code: string; name: string; ledgerMinor: number; bookedMinor: number; differenceMinor: number }>;
}

const eur = (m: number) => (m / 100).toFixed(2);

/**
 * Work out a livestock valuation (issue #540). Every group with animals on
 * the date, or valued last time, needs a value per head and its basis.
 * `opening` values the herd at the book's start: it posts nothing, and must
 * agree with the opening balance already on the stock accounts.
 */
export function planLivestockValuation(db: AppDatabase, p: {
  companyId: string; date: string; opening?: boolean;
  values: Record<string, { valuePerHeadMinor: number; basis: string }>;
}): LivestockValuationPlan {
  const date = asIsoDate(requireFarmDate(p.date, 'The valuation date'));
  const last = db.select().from(livestockValuations).where(eq(livestockValuations.companyId, p.companyId))
    .orderBy(desc(livestockValuations.valuationDate)).get();
  if (last && last.valuationDate >= date) throw new FarmError(`Livestock was already valued at ${last.valuationDate}: value it after that date.`);
  if (p.opening && last) throw new FarmError('The opening valuation is the first one.');
  const counts = headCounts(db, { companyId: p.companyId, asOf: date });
  const previous = new Map((last?.lines ?? []).map((l) => [l.groupId, l.valueMinor]));
  const groups = listAnimalGroups(db, p.companyId).filter((g) => (counts.get(g.id) ?? 0) > 0 || previous.has(g.id));
  const values = new Map(Object.entries(p.values).map(([k, v]) => [requireGroup(db, p.companyId, k).id, v]));
  const missing = groups.filter((g) => (counts.get(g.id) ?? 0) > 0 && !values.has(g.id));
  if (missing.length) throw new FarmError(`Give a value per head for: ${missing.map((g) => g.name).join(', ')}.`);
  const lines = groups.map((g) => {
    const headCount = counts.get(g.id) ?? 0;
    const v = values.get(g.id) ?? { valuePerHeadMinor: 0, basis: 'none on hand' };
    if (!Number.isInteger(v.valuePerHeadMinor) || v.valuePerHeadMinor < 0) throw new FarmError(`${g.name}: the value per head is a whole number of minor units.`);
    if (headCount > 0 && !v.basis.trim()) throw new FarmError(`${g.name}: say what the value per head is based on (cost, market value…).`);
    const valueMinor = headCount * v.valuePerHeadMinor;
    const previousMinor = previous.get(g.id) ?? 0;
    return {
      groupId: g.id, name: g.name, enterpriseId: g.enterpriseId, headCount, valuePerHeadMinor: v.valuePerHeadMinor, valueMinor,
      basis: v.basis.trim(), stockAccountId: g.stockAccountId, changeAccountId: g.changeAccountId, previousMinor,
      changeMinor: p.opening ? 0 : valueMinor - previousMinor,
    };
  });
  const stockAccountIds = [...new Set(lines.map((l) => l.stockAccountId))];
  const stockAccounts = stockAccountIds.map((accountId) => {
    const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get()!;
    const ledgerMinor = accountBalance(db, { companyId: p.companyId, accountId, asOf: date });
    const mine = lines.filter((l) => l.stockAccountId === accountId);
    // The opening valuation must equal the opening balance; later ones start from the last booked value.
    const bookedMinor = mine.reduce((s, l) => s + (p.opening ? l.valueMinor : l.previousMinor), 0);
    return { accountId, code: account.code, name: account.name, ledgerMinor, bookedMinor, differenceMinor: ledgerMinor - bookedMinor };
  });
  return { date, opening: !!p.opening, lines, valueMinor: lines.reduce((s, l) => s + l.valueMinor, 0), stockAccounts };
}

/**
 * Post a livestock valuation (issue #540): one journal moving each group's
 * change in value between its stock account and its change-in-value account,
 * in an open period. Refused, with a review item, when a stock account does
 * not hold what was last booked there.
 */
export function postLivestockValuation(db: AppDatabase, p: Parameters<typeof planLivestockValuation>[1] & { postedBy: string }): {
  valuationId: string; journalEntryId: string | null; plan: LivestockValuationPlan;
} {
  const plan = planLivestockValuation(db, p);
  const off = plan.stockAccounts.filter((a) => a.differenceMinor !== 0);
  for (const a of off) {
    upsertReviewItem(db, {
      companyId: p.companyId, kind: 'reconciliation_difference', severity: 'warning',
      title: `Livestock: ${a.code} ${a.name} holds ${eur(a.ledgerMinor)}, not the ${eur(a.bookedMinor)} ${plan.opening ? 'valued' : 'last booked'}`,
      detail: plan.opening
        ? `The opening valuation at ${plan.date} comes to ${eur(a.bookedMinor)}, but the opening balance on ${a.code} is ${eur(a.ledgerMinor)}. `
          + 'Correct the opening balance or the values per head so they agree.'
        : `On ${plan.date} the ledger holds ${eur(a.ledgerMinor)} on ${a.code} and the last livestock valuation booked ${eur(a.bookedMinor)}. `
          + 'Find the entry posted to the account outside a livestock valuation.',
      entityType: 'account', entityId: a.accountId, dedupeKey: `livestock_valuation:${a.accountId}:${plan.date}`,
      context: { ...a, date: plan.date },
    });
  }
  if (off.length) {
    throw new FarmError(`The livestock account does not agree: ${off.map((a) => `${a.code} holds ${eur(a.ledgerMinor)}, `
      + `${plan.opening ? 'valued' : 'booked'} ${eur(a.bookedMinor)}`).join('; ')}. See the review queue.`);
  }
  return atomically(db, () => {
    const company = db.select().from(companies).where(eq(companies.id, p.companyId)).get();
    if (!company) throw new FarmError(`Company ${p.companyId} not found.`);
    assertAccountingPeriodOpen(db, p.companyId, plan.date);
    const valuationId = ids.livestockValuation();
    const lines = plan.lines.filter((l) => l.changeMinor !== 0).flatMap((l) => l.changeMinor > 0
      ? [{ accountId: l.stockAccountId, debitMinor: l.changeMinor, memo: `${l.name}: increase in livestock value` },
        { accountId: l.changeAccountId, creditMinor: l.changeMinor, memo: `${l.name}: increase in livestock value` }]
      : [{ accountId: l.changeAccountId, debitMinor: -l.changeMinor, memo: `${l.name}: fall in livestock value` },
        { accountId: l.stockAccountId, creditMinor: -l.changeMinor, memo: `${l.name}: fall in livestock value` }]);
    let journalEntryId: string | null = null;
    if (lines.length) {
      journalEntryId = postJournalEntry(db, {
        companyId: p.companyId, entryDate: plan.date, narrative: `Livestock valuation at ${plan.date}: ${eur(plan.valueMinor)}`,
        sourceType: 'livestock_valuation', sourceId: valuationId, baseCurrency: company.baseCurrency,
        createdBy: p.postedBy, createdVia: 'user', lines,
      }).id;
    }
    db.insert(livestockValuations).values({
      id: valuationId, companyId: p.companyId, valuationDate: plan.date, valueMinor: plan.valueMinor, journalEntryId,
      lines: plan.lines.map(({ name: _name, previousMinor: _previous, ...l }) => l), postedBy: p.postedBy,
    }).run();
    return { valuationId, journalEntryId, plan };
  });
}

export function listLivestockValuations(db: AppDatabase, companyId: string) {
  return db.select().from(livestockValuations).where(eq(livestockValuations.companyId, companyId))
    .orderBy(desc(livestockValuations.valuationDate)).all();
}
