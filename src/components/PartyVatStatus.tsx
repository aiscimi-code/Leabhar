import { Panel, Badge, Field, Select, Textarea, Disclosure } from '@/components/primitives';
import { ActionForm } from '@/components/ActionForm';
import { confirmEstablishmentAction, confirmTaxableStatusAction, checkViesAction } from '@/app/parties-actions';
import { viesCurrent } from '@/domain/parties/status';
import { date } from '@/lib/format';

interface PartyStatusRow {
  id: string;
  name: string;
  vatNumber: string | null;
  establishment: 'in_state' | 'outside_state' | null;
  establishmentBasis: string | null;
  establishmentConfirmedBy: string | null;
  establishmentConfirmedAt: string | null;
  viesStatus: 'valid' | 'invalid' | 'unavailable' | null;
  viesCheckedAt: string | null;
  viesCheckedVatNumber: string | null;
  viesName: string | null;
  viesAddress: string | null;
  viesRequestIdentifier: string | null;
  taxableStatus?: 'taxable_person' | 'non_taxable_person' | null;
  taxableStatusConfirmedBy?: string | null;
  taxableStatusConfirmedAt?: string | null;
}

/**
 * Where a supplier or customer is established, whether a customer buys as a
 * business, and the VIES check of its VAT number (issue #207). None of these
 * can be read from a country code; the VAT rules that depend on them are
 * flagged until a person records them here.
 */
export function PartyVatStatus({ party, kind }: { party: PartyStatusRow; kind: 'supplier' | 'customer' }) {
  const vies = viesCurrent(party) ? party.viesStatus : null;
  return (
    <Panel
      title="VAT status"
      description="Where the business is established decides whether a reverse charge applies and where a service
        is supplied. A country or an address does not settle it: record what you relied on."
    >
      <table className="ledger">
        <tbody>
          <tr>
            <td className="w-48 text-ink-faint">Established</td>
            <td>
              {party.establishment
                ? <>
                    <Badge tone="positive">{party.establishment === 'outside_state' ? 'Outside Ireland' : 'In Ireland'}</Badge>
                    <div className="text-[11px] text-ink-faint">
                      {party.establishmentBasis} — confirmed by {party.establishmentConfirmedBy}
                      {party.establishmentConfirmedAt ? ` on ${date(party.establishmentConfirmedAt.slice(0, 10))}` : ''}
                    </div>
                  </>
                : <Badge tone="caution">Not recorded</Badge>}
            </td>
          </tr>
          {kind === 'customer' && (
            <tr>
              <td className="text-ink-faint">Buys as</td>
              <td>
                {party.taxableStatus
                  ? <>
                      <Badge tone="positive">{party.taxableStatus === 'taxable_person' ? 'A business' : 'A consumer'}</Badge>
                      {party.taxableStatusConfirmedBy && (
                        <span className="text-[11px] text-ink-faint"> confirmed by {party.taxableStatusConfirmedBy}</span>
                      )}
                    </>
                  : <Badge tone="caution">Not recorded</Badge>}
              </td>
            </tr>
          )}
          <tr>
            <td className="text-ink-faint">VIES</td>
            <td>
              {!party.vatNumber ? <span className="text-ink-faint">No VAT number</span>
                : vies === 'valid' ? <Badge tone="positive">Valid</Badge>
                : vies === 'invalid' ? <Badge tone="negative">Not valid</Badge>
                : vies === 'unavailable' ? <Badge tone="caution">VIES could not answer</Badge>
                : <Badge tone="neutral">Not checked</Badge>}
              {vies && party.viesCheckedAt && (
                <div className="text-[11px] text-ink-faint">
                  {party.viesCheckedVatNumber} checked {date(party.viesCheckedAt.slice(0, 10))}
                  {party.viesName ? ` — ${party.viesName}` : ''}{party.viesAddress ? `, ${party.viesAddress}` : ''}
                  {party.viesRequestIdentifier ? ` (consultation ${party.viesRequestIdentifier})` : ''}
                </div>
              )}
            </td>
          </tr>
        </tbody>
      </table>

      {party.vatNumber && (
        <ActionForm action={checkViesAction} submit="Check with VIES" variant="secondary" inline
          extra={{ party: kind, partyId: party.id }} />
      )}

      <Disclosure summary="Record where it is established">
        <ActionForm action={confirmEstablishmentAction} submit="Record establishment"
          extra={{ party: kind, partyId: party.id }}>
          <div className="grid grid-cols-2 gap-3 max-w-3xl">
            <Field label="Established">
              <Select name="establishment" defaultValue={party.establishment ?? ''} required>
                <option value="" disabled>Choose</option>
                <option value="outside_state">Outside Ireland</option>
                <option value="in_state">In Ireland</option>
              </Select>
            </Field>
            <Field
              label="What this rests on"
              help="Where it has its seat of economic activity, and whether it has a branch in Ireland with its own
                staff and equipment that supplies you (EU Reg 282/2011 arts.10-11)."
            >
              <Textarea name="basis" rows={2} defaultValue={party.establishmentBasis ?? ''} required />
            </Field>
          </div>
        </ActionForm>
      </Disclosure>

      {kind === 'customer' && (
        <Disclosure summary="Record whether it buys as a business">
          <ActionForm action={confirmTaxableStatusAction} submit="Record status" extra={{ partyId: party.id }}>
            <Field
              label="Buys as"
              help="A business customer (a taxable person) is where most services are supplied; a VAT number from an
                EU country is evidence of it (EU Reg 282/2011 art.18)."
            >
              <Select name="taxableStatus" defaultValue={party.taxableStatus ?? ''} required>
                <option value="" disabled>Choose</option>
                <option value="taxable_person">A business</option>
                <option value="non_taxable_person">A consumer</option>
              </Select>
            </Field>
          </ActionForm>
        </Disclosure>
      )}
    </Panel>
  );
}
