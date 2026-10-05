#!/usr/bin/env python3
"""Synthetic 20-year dairy farm: bank statements, invoices, payroll, herd register.

Fictional throughout: "Mullane Dairy Farm", a spring-calving herd of 205-300 cows in
Co. Cork, trading as a sole trader 1 Jan 2006 - 31 Dec 2025. Seeded, so the output is
reproducible:   python3 scripts/generate-dairy-farm-fixtures.py

The statements are deliberately dirty. fixtures/dairy-farm/answer_key_*.csv records the
truth for every line so a tool's output can be scored. See fixtures/dairy-farm/README.md.

Rates (VAT, flat-rate addition, scheme amounts, prices) are plausible approximations for
exercising the tool, NOT a source for a real return. Money is integer cents throughout.
"""
import csv
import hashlib
import os
import random
from collections import defaultdict
from datetime import date, timedelta

R = random.Random(2006)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'fixtures', 'dairy-farm')
Y0, Y1 = 2006, 2025
END = date(Y1, 12, 31)
VAT_REG = date(2015, 1, 1)          # flat-rate farmer until the expansion, VAT-registered after
MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']


def c(x):
    return int(round(x * 100))


def eur(cents):
    return f'{cents / 100:.2f}'


def yr_list(d):
    return [d[y] for y in range(Y0, Y1 + 1)]


def eom(y, m):
    return (date(y + (m == 12), m % 12 + 1, 1) - timedelta(days=1))


def bday(d):
    while d.weekday() >= 5 or (d.month, d.day) in ((12, 25), (12, 26), (1, 1), (3, 17)):
        d += timedelta(days=1)
    return d


def rdate(y, m, lo=1, hi=28):
    return date(y, m, R.randint(lo, min(hi, eom(y, m).day)))


# ----------------------------------------------------------------------------- yearly parameters
HERD = dict(zip(range(Y0, Y1 + 1), [205, 208, 212, 216, 220, 218, 226, 224, 236, 252,
                                    272, 288, 294, 292, 298, 300, 292, 262, 258, 266]))
YIELD_ADJ = {2008: 60, 2009: -150, 2011: -100, 2012: -220, 2013: -480, 2014: 80, 2018: -260,
             2019: -80, 2020: 60, 2023: -120}
MILK_C = dict(zip(range(Y0, Y1 + 1), [29.0, 33.5, 35.5, 24.0, 30.5, 33.5, 31.0, 37.0, 38.0, 29.5,
                                      28.5, 36.5, 33.5, 34.0, 33.0, 41.0, 59.0, 46.0, 43.0, 45.0]))
MILK_DRIFT = {2007: .12, 2008: -.10, 2009: .12, 2011: .05, 2013: .06, 2014: -.22, 2015: .06, 2016: .22,
              2021: .25, 2022: .20, 2023: -.25, 2024: .10, 2025: .04}
SHARE = [1.5, 5, 10, 14, 15, 14, 12.5, 11, 8.5, 5.5, 2.5, 0.5]
CPI = dict(zip(range(Y0, Y1 + 1), [100, 104, 108, 104, 103, 105, 107, 108, 108, 108,
                                   108, 110, 112, 113, 113, 116, 126, 134, 138, 141]))
FEEDX = dict(zip(range(Y0, Y1 + 1), [100, 115, 140, 120, 115, 140, 160, 160, 140, 130,
                                     125, 130, 150, 135, 130, 160, 220, 190, 160, 150]))
FERTX = dict(zip(range(Y0, Y1 + 1), [100, 105, 175, 120, 105, 135, 150, 145, 130, 120,
                                     105, 110, 115, 112, 100, 150, 270, 190, 145, 145]))
DIESELX = dict(zip(range(Y0, Y1 + 1), [100, 105, 150, 100, 120, 145, 150, 145, 125, 95,
                                      95, 105, 115, 125, 95, 115, 190, 165, 150, 140]))
ELECX = dict(zip(range(Y0, Y1 + 1), [100, 105, 125, 125, 120, 130, 135, 140, 140, 138,
                                    135, 135, 140, 145, 145, 155, 270, 250, 190, 175]))
BULL_CALF = dict(zip(range(Y0, Y1 + 1), [85, 90, 95, 55, 85, 95, 90, 100, 90, 55,
                                        25, 45, 60, 55, 45, 70, 120, 160, 210, 250]))
CULL_PRICE = dict(zip(range(Y0, Y1 + 1), [650, 690, 720, 520, 600, 740, 770, 800, 850, 790,
                                         700, 860, 950, 880, 850, 1050, 1350, 1400, 1250, 1200]))
CULL_RATE = {y: 0.18 for y in range(Y0, Y1 + 1)}
CULL_RATE.update({2013: .22, 2018: .28, 2022: .20, 2023: .27, 2024: .22})
LOAN_RATE = dict(zip(range(Y0, Y1 + 1), [5.4, 6.0, 6.2, 3.5, 3.3, 4.0, 4.2, 4.0, 3.8, 3.6,
                                         3.4, 3.3, 3.3, 3.3, 3.3, 3.2, 4.5, 7.0, 6.8, 6.0]))
FRA = {**{y: 4.8 for y in range(2006, 2009)}, **{y: 5.2 for y in range(2009, 2015)}}
SFP = dict(zip(range(Y0, Y1 + 1), [16800, 17200, 17500, 17500, 17200, 17000, 17000, 16800, 16500, 18200,
                                  18000, 18300, 18500, 18400, 18300, 18000, 17500, 15900, 15800, 15700]))
RENT_ACRES = dict(zip(range(Y0, Y1 + 1), [45] * 4 + [50] * 4 + [55] * 4 + [70] * 8))
RENT_PER_ACRE = dict(zip(range(Y0, Y1 + 1), [240, 260, 270, 250, 240, 250, 260, 270, 280, 290,
                                            300, 320, 330, 340, 340, 350, 400, 430, 450, 450]))


def std_rate(d):
    if d < date(2008, 12, 1):
        return .21
    if d < date(2010, 1, 1):
        return .215
    if d < date(2012, 1, 1):
        return .21
    if date(2020, 9, 1) <= d < date(2021, 3, 1):
        return .21
    return .23


def rate_of(kind, d):
    return {'std': std_rate(d), 'red': .135, 'livestock': .048, 'zero': 0.0, 'exempt': 0.0,
            'none': 0.0}[kind]


# ----------------------------------------------------------------------------- parties
SUP = {
    'coop': ('Slieve Dairy Co-Operative Society Ltd', 'MS'),
    'coopstores': ('Slieve Dairy Co-Op Farm Stores', 'CS'),
    'feed': ('Glenfern Feeds Ltd', 'GF'),
    'fert': ('Kilcummin Agri Supplies Ltd', 'KA'),
    'vet': ('Lisheen Veterinary Clinic', 'LV'),
    'ai': ('Southern Genetics Co-Op', 'SG'),
    'lyons': ('Lyons Agri Contracting Ltd', 'LAC'),
    'obrien': ("O'Brien Plant Hire Ltd", 'OB'),
    'fuel': ('Ballyhoura Fuels Ltd', 'BF'),
    'esb': ('ESB Electric Supply', 'ES'),
    'parts': ('Charleville Farm Parts & Tyres Ltd', 'CFP'),
    'hyg': ('Dairy Hygiene Supplies Ltd', 'DHS'),
    'ins': ('Munster Farm Insurance Ltd', 'MFI'),
    'acct': ('Hegarty & Co Farm Accountants', 'HC'),
    'tea': ('Teagasc', 'TG'),
    'sol': ('Fitzgerald & Co Solicitors', 'FS'),
    'tel': ('Vodafone Ireland', 'VF'),
    'plast': ('AgriWrap Plastics Ltd', 'AW'),
    'hoof': ('Cork Hoof Care Services', 'HF'),
    'mart': ('Kilbeg Livestock Mart Ltd', 'LD'),
    'meat': ('Southern Meats Ltd', 'SM'),
    'knack': ('Munster Rendering Ltd', 'MR'),
    'tractors': ('Munster Tractors Ltd', 'MT'),
    'milksys': ('DairyTech Milking Systems Ltd', 'DT'),
    'build': ('Corcaigh Building Contractors Ltd', 'CB'),
    'steel': ('Murphy Steel Fabrication Ltd', 'MSF'),
    'solar': ('SolarFarm Energy Ltd', 'SF'),
    'motors': ('Rathcormac Motors Ltd', 'RM'),
    'ghost': ('P. Crowley Plant & Labour', 'PC'),
    'resort': ('Algarve Golf & Spa Resort Lda', 'AG'),
    'hotel': ('Lakeland Park Hotel', 'LP'),
    'uk': ('Yorkshire Dairy Spares Ltd', 'YD'),
    'relief': ('FarmRelief Services Ltd', 'FR'),
    'soft': ('HerdTrack Software Ltd', 'HT'),
    'water': ('County Council Water Services', 'WS'),
    'finance': ('Southern Asset Finance DAC', 'SA'),
    'tesco': ('Tesco Ireland', 'TI'),
}
CUSTOMERS = ["J. Cronin", "M. O'Leary", "B. Walsh & Sons", "D. Buckley", "Tim Hennessy", "K. Murphy Farms Ltd",
             "Ballynoe Farms Partnership", "P. Dineen", "Coolcaum Dairy Ltd", "S. Kiely", "N. Barrett", "E. Foley & Son"]
VATNOS = {}


def vatno(key):
    if key not in VATNOS:
        h = int(hashlib.md5(key.encode()).hexdigest(), 16)
        VATNOS[key] = f'IE{h % 9000000 + 1000000}{"ABCDEFGHIJKLMNOPQRSTUVW"[h % 23]}'
    return VATNOS[key]


def pname(key):
    return SUP[key][0] if key in SUP else key


# ----------------------------------------------------------------------------- ledgers
BANK = {'cur': [], 'dep': []}
DOCS = []
OTHER = []
REGISTER = []
PAYSLIPS = []
CHEQUES = []
ISSUES = []
ANNUAL = defaultdict(dict)
_seq = {'t': 0, 'd': 0, 'o': 0, 'chq': 4500, 'sup': defaultdict(int)}
STMT_POOL = defaultdict(list)       # (supplier, y, m) -> [docs] paid as one lump
COOP_POOL = defaultdict(list)       # (y, m) -> [docs] netted off that month's milk cheque
FUTURE = defaultdict(list)          # (y, m) -> [txn] injected by the cash simulation


def issue(code, kind, year, text, expect):
    ISSUES.append(dict(code=code, kind=kind, year=year, what=text, expected_tool_behaviour=expect))


def add_bank(acct, d, desc, amt, ref='', cat='', biz='Y', docs=(), flag='', note=''):
    _seq['t'] += 1
    t = dict(tid=_seq['t'], acct=acct, date=d, desc=desc, amt=amt, ref=ref, cat=cat, biz=biz,
             docs=[x['id'] for x in docs], flag=flag, note=note)
    if d <= END:
        BANK[acct].append(t)
    return t


def add_doc(direction, d, party, desc, net, kind, cat, vat=None, number=None, due=30, typ='invoice',
            ccy='EUR', supply=None, vatno_ok=True, biz='Y', flag='', note='', ref='', rate=None, deductible=True):
    _seq['d'] += 1
    key = party if party in SUP else None
    pre = SUP[party][1] if party in SUP else 'DOC'
    if number is None:
        _seq['sup'][(party, d.year)] += 1
        number = f'{pre}{d.year % 100:02d}-{_seq["sup"][(party, d.year)]:04d}'
    r = rate_of(kind, d) if rate is None else rate
    if direction == 'purchase' and kind == 'zero':
        r = 0.0
    v = int(round(net * r)) if vat is None else vat
    if typ == 'credit_note':
        pass  # figures stay positive as printed; type carries the sign
    pn = pname(party)
    doc = dict(id=f'D{_seq["d"]:05d}', direction=direction, number=number, date=d, party=pn,
               desc=desc, net=net, vat=v, gross=net + v, due=d + timedelta(days=due), ccy=ccy,
               ref=ref, typ=typ, supply=supply or '', partyvat=(vatno(party) if (key and vatno_ok and kind not in ('exempt',)) else ''),
               cat=cat, biz=biz, flag=flag, note=note, vat_rate=r, deductible=deductible, vkind=kind)
    DOCS.append(doc)
    return doc


def add_other(kind, d, issuer, subject, gross=0, net=0, ref='', note=''):
    _seq['o'] += 1
    o = dict(id=f'O{_seq["o"]:05d}', kind=kind, date=d, issuer=issuer, subject=subject, gross=gross, net=net, ref=ref, note=note)
    OTHER.append(o)
    return o


# ----------------------------------------------------------------------------- payments
def pay_desc(party, mode, d, docs, amt):
    nm = pname(party).upper().replace(' LTD', '').replace(',', '')
    if mode == 'chq':
        _seq['chq'] += R.randint(1, 3)
        no = _seq['chq']
        if R.random() < .85:
            CHEQUES.append(dict(no=no, date=d - timedelta(days=R.randint(0, 3)), payee=pname(party), amount=amt,
                                memo=' '.join(x['number'] for x in docs)[:60]))
        return f'CHQ {no:06d}', ''
    if mode == 'pos':
        return f'POS {nm[:22]}', ''
    if mode == 'dd':
        return f'D/D {nm[:26]}', ''
    ref = docs[0]['number'] if docs and len(docs) == 1 else ''
    return f'SEPA CT {nm[:28]}', ref


def pay_out(party, d, docs, mode='auto', lag=None, amt=None, cat='', biz='Y', flag='', note=''):
    total = sum(x['gross'] for x in docs) if amt is None else amt
    if typ_credit(docs):
        total = sum(x['gross'] * (-1 if x['typ'] == 'credit_note' else 1) for x in docs) if amt is None else amt
    if mode == 'auto':
        if d.year < 2013:
            mode = R.choices(['chq', 'sepa', 'dd'], [60, 25, 15])[0]
        else:
            mode = R.choices(['sepa', 'pos', 'chq'], [70, 22, 8])[0]
    if lag is None:
        lag = R.randint(5, 38)
    pd = bday(d + timedelta(days=lag))
    desc, ref = pay_desc(party, mode, pd, docs, total)
    if R.random() < .12 and ref:
        ref = ''
    cat = cat or (docs[0]['cat'] if docs else '')
    return add_bank('cur', pd, desc, -total, ref, cat, biz, docs, flag, note)


def typ_credit(docs):
    return any(x['typ'] == 'credit_note' for x in docs)


def purchase(d, sup, desc, net, kind, cat, pay='auto', lag=None, biz='Y', ded=True, doc_ok=True, **kw):
    """Create a supplier invoice and (unless netted off milk or still unpaid at the end) its payment."""
    dc = add_doc('purchase', d, sup, desc, net, kind, cat, biz=biz, deductible=ded, **kw)
    if pay == 'coop':
        COOP_POOL[(d.year, d.month)].append(dc)
        dc['ref'] = 'netted off milk payment'
        return dc, None
    if pay == 'stmt':
        STMT_POOL[(sup, d.year, d.month)].append(dc)
        return dc, None
    if pay == 'none':
        return dc, None
    t = pay_out(sup, d, [dc], pay, lag, cat=cat, biz=biz)
    return dc, t


def flush_statements():
    for (sup, y, m), docs in sorted(STMT_POOL.items()):
        nxt = date(y + (m == 12), m % 12 + 1, R.randint(15, 24))
        mode = 'chq' if y < 2013 and R.random() < .6 else 'sepa'
        t = pay_out(sup, nxt, docs, mode, lag=0, cat=docs[0]['cat'])
        if len(docs) > 1:
            t['ref'] = f'STMT {MON[m - 1]} {y % 100:02d}'
    STMT_POOL.clear()


def sale(d, cust, desc, net, kind, cat, lag=None, mode='sepa', cashbasis=False, **kw):
    dc = add_doc('sales', d, cust, desc, net, kind, cat, **kw)
    pd = bday(d + timedelta(days=lag if lag is not None else R.randint(10, 50)))
    nm = cust.upper()[:26]
    desc_b = {'sepa': f'SEPA CR {nm}', 'chq': 'LODGMT CHQ ' + nm[:14]}[mode]
    t = add_bank('cur', pd, desc_b, dc['gross'], dc['number'] if R.random() < .7 else '', cat, 'Y', [dc])
    return dc, t


# ----------------------------------------------------------------------------- category generator
def spread(y, total_net, weights, avg):
    n = max(1, int(round(total_net / avg)))
    months = R.choices(range(1, 13), weights, k=n)
    base = total_net / n
    out = []
    for m in months:
        out.append((rdate(y, m), max(c(30), c(base * R.uniform(.55, 1.5)))))
    return out


W_FEED = [11, 11, 9, 6, 3, 2, 2, 3, 6, 11, 14, 12]
W_FERT = [3, 14, 18, 12, 10, 14, 10, 8, 4, 2, 1, 0]
W_VET = [8, 12, 12, 10, 7, 6, 6, 7, 8, 7, 6, 6]
W_CONT = [3, 4, 10, 8, 16, 18, 10, 14, 10, 5, 2, 2]
W_DIES = [5, 6, 9, 10, 11, 11, 10, 9, 9, 9, 6, 5]
W_FLAT = [8] * 12


def yearly_expenses(y, cows):
    k = CPI[y] / 100
    drought = 1.22 if y == 2018 else 1.12 if y == 2013 else 1.0
    items = [
        # cat, supplier choices, total_net, weights, avg invoice, VAT kind, desc, coop share, biz
        ('feed', [('feed', .6), ('coopstores', .4)], cows * 170 * FEEDX[y] / 100 * drought, W_FEED, 3600, 'zero',
         lambda m, n: R.choice(['Dairy ration 16% bulk', 'Dairy ration 18% nuts', 'Calf starter + milk replacer',
                                'Maize meal / soya hulls blend', 'Mineral supplement']) + f' - {n / 100 / (300 * FEEDX[y] / 100 * 0.93):.1f} t'),
        ('fertiliser', [('fert', .55), ('coopstores', .45)], cows * 125 * FERTX[y] / 100, W_FERT, 6200, 'red',
         lambda m, n: R.choice(['CAN 27%', 'Protected urea', '18-6-12 compound', 'Pasture sward 24-2.5-10', 'Ground limestone']) + ' bulk spread'),
        ('vet_medicine', [('vet', 1)], cows * 70 * k, W_VET, 520, 'std',
         lambda m, n: R.choice(['Herd health visit + drugs', 'Dry cow therapy / sealers', 'Fertility scanning', 'Calving assistance',
                                'Vaccines (BVD/IBR/lepto)', 'Mastitis treatments'])),
        ('breeding_ai', [('ai', 1)], cows * 22 * k, [10, 10, 0, 0, 0, 14, 18, 18, 12, 5, 2, 4][:12] if False else
         [1, 2, 14, 22, 24, 18, 10, 4, 1, 1, 1, 2], 650, 'std', lambda m, n: 'Semen straws + AI technician service'),
        ('contractors', [('lyons', .65), ('obrien', .35)], cows * 95 * k, W_CONT, 2600, 'red',
         lambda m, n: R.choice(['Silage harvesting (1st cut)', 'Slurry spreading (trailing shoe)', 'Reseeding / ploughing',
                                'Silage harvesting (2nd cut)', 'Hedge cutting', 'Baling + wrapping'])),
        ('fuel', [('fuel', 1)], cows * 48 * DIESELX[y] / 100, W_DIES, 1500, 'red',
         lambda m, n: 'Marked gas oil, bulk delivery'),
        ('repairs', [('parts', 1)], cows * 55 * k, W_FLAT, 380, 'std',
         lambda m, n: R.choice(['Tyres and tubes', 'Tractor service parts', 'Parlour liners', 'Welding rods / steel', 'Mower blades',
                                'Hydraulic hoses', 'Gate and fencing repairs'])),
        ('dairy_hygiene', [('hyg', 1)], cows * 25 * k, W_FLAT, 450, 'std',
         lambda m, n: 'Parlour detergents, teat dip, filter socks'),
        ('silage_plastic', [('plast', 1)], cows * 12 * k, [0, 0, 0, 0, 20, 30, 20, 25, 5, 0, 0, 0], 900, 'std',
         lambda m, n: 'Silage plastic, bale net, twine'),
        ('foot_care', [('hoof', 1)], cows * 14 * k, [10, 0, 0, 0, 0, 0, 20, 0, 0, 40, 30, 0], 650, 'std',
         lambda m, n: 'Hoof trimming / footbaths'),
    ]
    for cat, sups, total, w, avg, kind, dfn, in items:
        for d, net in spread(y, total, w, avg):
            sup = R.choices([s for s, _ in sups], [p for _, p in sups])[0]
            pay = 'coop' if sup == 'coopstores' else ('stmt' if R.random() < .45 else 'auto')
            if cat in ('feed', 'fertiliser', 'vet_medicine', 'contractors') and sup != 'coopstores' and R.random() < .6:
                pay = 'stmt'
            doc_ok = not (R.random() < .025 and sup != 'coopstores')
            dc, t = purchase(d, sup, dfn(d.month, net), net, kind, cat, pay)
            if not doc_ok and t is not None:
                DOCS.remove(dc)
                t['docs'] = []
                t['flag'] = 'MISSING_INVOICE'
                t['note'] = 'payment with no supplier invoice on file'
    # monthly fixed items
    for m in range(1, 13):
        e = eom(y, m)
        elec = c(cows * 3.4 * ELECX[y] / 100 * (1 - (0.38 if y >= 2024 else 0.0)) * R.uniform(.85, 1.15))
        dc, t = purchase(rdate(y, m, 3, 9), 'esb', f'Electricity {MON[m - 1].title()} {y} (farm + house meter)', elec, 'red', 'electricity',
                         'dd', 14, biz='M')
        dc['note'] = 'single meter: farmhouse and dairy; about 15% private'
        t['biz'] = 'M'
        purchase(rdate(y, m, 10, 12), 'tel', 'Mobile and broadband', c(130 * (1 + (y - 2006) * .02) * R.uniform(.9, 1.1)), 'std', 'telephone',
                 'dd', 8, biz='M')
        if y >= 2016:
            purchase(rdate(y, m, 1, 3), 'soft', 'Herd management subscription', c(88), 'std', 'software', 'dd', 5)
        if y >= 2013:
            pass
    # annual items
    purchase(date(y, 2, R.randint(2, 20)), 'ins', 'Farm policy renewal (buildings, liability, machinery, employer liability)',
             c(cows * 29 * k + 1200), 'exempt', 'insurance', 'auto', 10)
    purchase(date(y, 3, R.randint(1, 14)), 'acct', f'Accounts, tax returns and payroll year {y - 1}', c(2300 * (CPI[y] / 100) * 1.2), 'std',
             'professional_fees', 'auto', 18)
    purchase(date(y, 6, R.randint(1, 20)), 'tea', 'Advisory service annual fee', c(900 * k), 'std', 'professional_fees', 'auto', 30)
    purchase(date(y, 5, R.randint(1, 20)), 'water', 'Water charges (metered, farm)', c(620 * k), 'zero', 'utilities', 'dd', 25, biz='M')
    # bank fees
    for m in range(1, 13):
        add_bank('cur', eom(y, m), 'ACCOUNT MAINTENANCE FEE', -c(14 + (y - 2006) * .7), '', 'bank_charges')
    add_bank('cur', date(y, 6, 30), 'FACILITY ARRANGEMENT FEE', -c(500 + 15 * (y - 2006)), '', 'bank_charges')


# ----------------------------------------------------------------------------- milk
def milk_litres_year(y):
    cows = HERD[y]
    return cows * (5100 + 40 * (y - 2006) + YIELD_ADJ.get(y, 0)) * R.uniform(.985, 1.015)


def run_milk():
    for (y, m) in [(2005, 12)] + [(yy, mm) for yy in range(Y0, Y1 + 1) for mm in range(1, 13) if not (yy == Y1 and mm == 12)]:
        py = max(y, Y0)
        pm = m
        L = milk_litres_year(py) * SHARE[m - 1] / 100 * R.uniform(.96, 1.04)
        L = int(round(L, -1))
        drift = MILK_DRIFT.get(py, 0) * (m - 6.5) / 6
        price = MILK_C[py] * (1 + drift) + R.uniform(-.25, .25)
        fat, prot = R.uniform(3.9, 4.6), R.uniform(3.3, 3.7)
        net = c(L * price / 100)
        e = eom(y, m)
        kind = 'livestock' if False else ('red' if e >= VAT_REG else 'none')
        if e < VAT_REG:
            vat = int(round(net * FRA[py] / 100))
            note = f'flat-rate addition {FRA[py]}%'
        else:
            vat = None
            note = 'VAT 13.5%'
        num = f'MS-{y}{m:02d}'
        ms = add_doc('sales', e, 'coop', f'Milk supplied {MON[m - 1].title()} {y}: {L:,} L @ {price:.2f} c/L, fat {fat:.2f}% protein {prot:.2f}% ({note})',
                     net, kind if kind != 'none' else 'none', 'milk_sales', vat=vat, number=num, due=25, typ='self_billed_statement',
                     rate=0.0 if kind == 'none' else None)
        ms['litres'] = L
        ANNUAL[py]['litres'] = ANNUAL[py].get('litres', 0) + (L if y >= Y0 else 0)
        ANNUAL[py]['milk_net'] = ANNUAL[py].get('milk_net', 0) + net
        pdte = bday(date(y + (m == 12), m % 12 + 1, 25))
        # deductions
        levy_net = c(L * (0.30 + 0.01 * (py - 2006)) / 100 + 85)
        levy = add_doc('purchase', e, 'coop', f'Co-op haulage, milk testing, levies {MON[m - 1].title()} {y}', levy_net, 'std', 'milk_levies',
                       number=f'CL-{y}{m:02d}', due=0, ref=f'deducted from {num}')
        ded_docs = [levy]
        stores = sorted(COOP_POOL.get((y, m), []), key=lambda x: x['date'])
        room = int(ms['gross'] * .9) - levy['gross']
        keep = []
        for x in stores:       # a co-op carries what the cheque cannot cover into next month
            if x['gross'] <= room:
                keep.append(x)
                room -= x['gross']
            else:
                COOP_POOL[(y + (m == 12), m % 12 + 1)].append(x)
        stores = keep
        ded_docs += stores
        deduct = sum(x['gross'] for x in ded_docs)
        super_levy = 0
        note_bank = ''
        if (y, m) in ((2008, 2), (2011, 3)):
            super_levy = c(12400 if y == 2008 else 9800)
            sl = add_doc('purchase', e, 'coop', f'Milk quota super-levy assessment {y - 1}/{y % 100:02d} (over-production)', super_levy, 'none', 'milk_quota_levy',
                         number=f'SL-{y}', due=0, vat=0, ref=f'deducted from {num}')
            ded_docs.append(sl)
            deduct += super_levy
            issue('SUPERLEVY', 'info', y, 'Super-levy deducted from the milk cheque', 'Treat as a trading cost; do not match a separate payment.')
        loan_ded = 0
        if (y == 2009 and 4 <= m <= 12) or (y == 2010 and m <= 1) or (y == 2016 and 6 <= m <= 12):
            loan_ded = c(3000 if y == 2009 else 3500)
            ded_docs_loan = True
        bank_amt = ms['gross'] - deduct - loan_ded
        t = add_bank('cur', pdte, f'SLIEVE DAIRY COOP MILK PMT {MON[m - 1]} {y % 100:02d}', bank_amt, num, 'milk_receipt', 'Y',
                     [ms] + ded_docs, note=('net of co-op loan instalment' if loan_ded else 'net of co-op deductions'))
        if loan_ded:
            t['flag'] = 'NETTED_LOAN_REPAYMENT'
            add_other('coop_loan_deduction', pdte, pname('coop'), f'Instalment deducted from milk payment {num}', gross=loan_ded, ref=num)
        COOP_POOL.pop((y, m), None)
    # co-op advances (milk price support loans)
    for y, amt, label in ((2009, 25000, 'Milk price support loan'), (2016, 24500, 'Fodder & price support loan')):
        d = bday(date(y, 3 if y == 2009 else 5, 12))
        add_bank('cur', d, 'SLIEVE DAIRY COOP LOAN ADVANCE', c(amt), '', 'loan_drawdown', 'Y',
                 note='repaid by deductions from milk cheques')
        add_other('loan_agreement', d, pname('coop'), label, gross=c(amt), note='repaid in instalments via milk payment')
        issue('COOP_LOAN', 'info', y, 'Loan advance lodged, repaid inside milk cheques', 'Not income. Liability reducing through netted milk payments.')


# ----------------------------------------------------------------------------- livestock
def run_livestock():
    prev = HERD[Y0]
    for y in range(Y0, Y1 + 1):
        cows = HERD[y]
        births = int(round(cows * R.uniform(.9, .96)))
        calf_deaths = int(round(births * R.uniform(.03, .06)))
        males = births // 2 - calf_deaths // 2
        females = births - births // 2 - (calf_deaths - calf_deaths // 2)
        cull = int(round(cows * CULL_RATE[y]))
        adult_deaths = int(round(cows * R.uniform(.015, .03)))
        growth = max(0, HERD[min(y + 2, Y1)] - cows)
        retain = min(females, int(round(cows * .21 + growth * .9)))
        sell_fem = females - retain
        ANNUAL[y].update(dict(cows=cows, births=births, calf_deaths=calf_deaths, adult_deaths=adult_deaths,
                              culls=cull, bull_calves=males, heifers_retained=retain, heifer_calves_sold=sell_fem))
        # births in the register (weekly, Feb-May)
        weeks = [date(y, 1, 20) + timedelta(days=7 * i) for i in range(18)]
        wts = [1, 2, 4, 6, 9, 11, 12, 12, 11, 9, 7, 5, 4, 3, 2, 1, 1, 1]
        for wk, n in zip(weeks, R.choices(range(18), wts, k=births) and [0] * 18):
            pass
        counts = defaultdict(int)
        for i in R.choices(range(18), wts, k=births):
            counts[i] += 1
        for i, n in sorted(counts.items()):
            REGISTER.append(dict(date=weeks[i], event='BIRTH', head=n, counterparty='', reference='', notes='calves registered'))
        for _ in range(calf_deaths):
            pass
        REGISTER.append(dict(date=date(y, 5, 31), event='DEATH_CALF', head=calf_deaths, counterparty='', reference='', notes='calf mortality to 31 May'))
        for mm in range(1, 13):
            if R.random() < .5 and adult_deaths:
                REGISTER.append(dict(date=rdate(y, mm), event='DEATH_ADULT', head=1, counterparty=pname('knack'), reference='collected', notes='fallen animal'))
        # fallen animal collections (cost)
        for _ in range(max(1, (adult_deaths + calf_deaths) // 6)):
            purchase(rdate(y, R.randint(1, 12)), 'knack', 'Fallen animal collection', c(R.choice([95, 110, 140, 160]) * CPI[y] / 100), 'std', 'fallen_animals')
        # calves to mart
        calves = males + sell_fem
        batches = R.randint(5, 8)
        for b in range(batches):
            n = calves // batches + (1 if b < calves % batches else 0)
            if n <= 0:
                continue
            d = bday(date(y, 3, 8) + timedelta(days=int(b * 80 / batches + R.randint(0, 6))))
            nb = n * (males / calves)
            price = BULL_CALF[y] * R.uniform(.88, 1.12)
            fem_n = int(round(n * sell_fem / calves))
            gross_net = c(price * (n - fem_n) + price * 1.12 * fem_n)
            kind = 'livestock' if d >= VAT_REG else 'none'
            fra = int(round(gross_net * FRA[y] / 100)) if d < VAT_REG else None
            dk = add_doc('sales', d, 'mart', f'Mart docket: {n} calves ({n - fem_n} bull, {fem_n} heifer) avg EUR {gross_net / 100 / n:.2f}',
                         gross_net, kind, 'livestock_sales', vat=fra, typ='sales_docket', due=7, number=f'LD-{y % 100:02d}-{R.randint(1000, 9999)}',
                         rate=0.0 if kind == 'none' else None)
            comm = add_doc('purchase', d, 'mart', f'Mart commission and levies on {dk["number"]}', int(gross_net * .028) + n * 400, 'std', 'mart_commission',
                           due=0, ref=dk['number'])
            add_bank('cur', bday(d + timedelta(days=R.randint(6, 10))), 'KILBEG LIVESTOCK MART SALE', dk['gross'] - comm['gross'], dk['number'],
                     'livestock_sale', 'Y', [dk, comm], note='net of commission')
            REGISTER.append(dict(date=d, event='SALE_MART', head=n, counterparty=pname('mart'), reference=dk['number'], notes='calves'))
        # cull cows
        left = cull
        n_batches = R.randint(3, 6)
        for b in range(n_batches):
            n = left // (n_batches - b)
            left -= n
            if n <= 0:
                continue
            d = bday(date(y, R.randint(7, 11), R.randint(1, 26)))
            if y == 2018:
                d = bday(date(y, R.randint(8, 10), R.randint(1, 26)))
            price = CULL_PRICE[y] * R.uniform(.9, 1.1)
            factory = R.random() < (.35 if y < 2012 else .65)
            net = c(price * n)
            kind = 'livestock' if d >= VAT_REG else 'none'
            fra = int(round(net * FRA[y] / 100)) if d < VAT_REG else None
            sup = 'meat' if factory else 'mart'
            dk = add_doc('sales', d, sup, f'{"Carcase" if factory else "Mart"} docket: {n} cull cows avg EUR {net / 100 / n:.2f}', net, kind,
                         'livestock_sales', vat=fra, typ='sales_docket', due=7, number=f'{SUP[sup][1]}-{y % 100:02d}-{R.randint(1000, 9999)}',
                         rate=0.0 if kind == 'none' else None)
            docs = [dk]
            amt = dk['gross']
            if not factory:
                comm = add_doc('purchase', d, 'mart', f'Mart commission and levies on {dk["number"]}', int(net * .028) + n * 400, 'std', 'mart_commission',
                               due=0, ref=dk['number'])
                docs.append(comm)
                amt -= comm['gross']
            add_bank('cur', bday(d + timedelta(days=R.randint(5, 12))), ('SOUTHERN MEATS' if factory else 'KILBEG LIVESTOCK MART SALE'), amt, dk['number'],
                     'livestock_sale', 'Y', docs)
            REGISTER.append(dict(date=d, event='SALE_FACTORY' if factory else 'SALE_MART', head=n, counterparty=pname(sup), reference=dk['number'], notes='cull cows'))
        # surplus in-calf heifers
        if y in (2012, 2018, 2022):
            n, price = {2012: (12, 1500), 2018: (15, 1650), 2022: (14, 2100)}[y]
            d = bday(date(y, 10, 14))
            net = c(n * price)
            kind = 'livestock' if d >= VAT_REG else 'none'
            fra = int(round(net * FRA[y] / 100)) if d < VAT_REG else None
            dk = add_doc('sales', d, 'mart', f'Mart docket: {n} in-calf heifers', net, kind, 'livestock_sales', vat=fra, typ='sales_docket', due=7,
                         number=f'LD-{y % 100:02d}-{R.randint(1000, 9999)}', rate=0.0 if kind == 'none' else None)
            comm = add_doc('purchase', d, 'mart', f'Mart commission and levies on {dk["number"]}', int(net * .028) + n * 400, 'std', 'mart_commission', due=0, ref=dk['number'])
            add_bank('cur', bday(d + timedelta(days=8)), 'KILBEG LIVESTOCK MART SALE', dk['gross'] - comm['gross'], dk['number'], 'livestock_sale', 'Y', [dk, comm])
            REGISTER.append(dict(date=d, event='SALE_MART', head=n, counterparty=pname('mart'), reference=dk['number'], notes='in-calf heifers'))
        # bought-in cows (expansion)
        buy = {2015: 15, 2016: 25, 2017: 20, 2024: 0}.get(y, 0)
        if buy:
            d = bday(date(y, 1, 28))
            net = c(buy * (1450 + 100 * (y - 2015)))
            dk = add_doc('purchase', d, 'mart', f'Mart docket: {buy} in-calf cows/heifers purchased', net, 'livestock', 'livestock_purchases', typ='sales_docket', due=0,
                         number=f'LD-{y % 100:02d}-{R.randint(1000, 9999)}')
            comm = add_doc('purchase', d, 'mart', f'Mart commission on {dk["number"]}', int(net * .02), 'std', 'mart_commission', due=0, ref=dk['number'])
            add_bank('cur', d + timedelta(days=1), 'CHQ %06d' % (_seq.__setitem__('chq', _seq['chq'] + 1) or _seq['chq']), -(dk['gross'] + comm['gross']), '',
                     'livestock_purchase', 'Y', [dk, comm])
            REGISTER.append(dict(date=d, event='PURCHASE', head=buy, counterparty=pname('mart'), reference=dk['number'], notes='in-calf cows'))
        prev = cows
        # year-end count
        REGISTER.append(dict(date=date(y, 12, 31), event='YEAR_END_COUNT', head=cows, counterparty='', reference='',
                             notes=f'milking cows; replacement heifers {retain + int(cows * .2)}; calves under 1yr {retain}'))


# ----------------------------------------------------------------------------- unrecorded sales (evasion)
def run_cash_sales_evasion():
    plan = {2009: (12, 2), 2010: (14, 3), 2011: (10, 4), 2012: (16, 3), 2013: (18, 4), 2017: (9, 0), 2018: (11, 3), 2019: (13, 4)}
    for y, (calves, cows) in plan.items():
        d = bday(date(y, R.randint(3, 4), R.randint(2, 25)))
        REGISTER.append(dict(date=d, event='MOVE_OFF_NO_DOCKET', head=calves, counterparty='R. Foley (dealer, private yard)', reference='',
                             notes='calves moved off; no mart docket, no invoice, no bank receipt'))
        val = calves * BULL_CALF[y]
        if cows:
            d2 = bday(date(y, R.randint(9, 11), R.randint(2, 25)))
            REGISTER.append(dict(date=d2, event='MOVE_OFF_NO_DOCKET', head=cows, counterparty='R. Foley (dealer, private yard)', reference='',
                                 notes='cull cows moved off; no docket, no bank receipt'))
            val += cows * CULL_PRICE[y]
        issue(f'E1-{y}', 'evasion', y, f'{calves} calves and {cows} cows moved off to a dealer for cash (about EUR {val:,.0f}); not banked, no docket',
              'Reconcile register movements to dockets and bank receipts; flag animals with no sale evidence; estimate suppressed income; review item.')
        # part of the cash is lodged weeks later, round, unexplained
        if y in (2011, 2013, 2018):
            part = int(val * .35 / 100) * 100
            add_bank('cur', bday(d + timedelta(days=21)), 'CASH LODGEMENT', c(part), '', 'unexplained_credit', 'U',
                     flag=f'E1-{y}', note='cash lodgement with no source; probably part of the dealer cash')
    # undeclared contracting cash (2016-2024)
    for y in range(2016, 2025, 2):
        for k in range(R.randint(2, 4)):
            d = bday(rdate(y, R.randint(5, 9)))
            amt = c(R.choice([850, 1200, 1500, 2400, 3100]))
            add_bank('cur', d, 'CASH LODGEMENT', amt, '', 'unexplained_credit', 'U', flag=f'E2-{y}',
                     note='contracting job paid in cash, no invoice raised, no output VAT')
        issue(f'E2-{y}', 'evasion', y, 'Contracting paid in cash, no sales invoice and no output VAT on the VAT3',
              'Unexplained round-sum lodgements in the contracting season with no invoice; flag as possible unrecorded income and unreturned output VAT.')


# ----------------------------------------------------------------------------- contracting income
def run_contracting():
    for y in range(2011, Y1 + 1):
        total = 6500 * (CPI[y] / 100) * (1 + (y - 2011) * .22) * (1.15 if y >= 2020 else 1)
        total = min(total, 31000 * CPI[y] / 100)
        for d, net in spread(y, total, [0, 0, 8, 10, 14, 18, 14, 14, 10, 6, 4, 2], 1500):
            cust = R.choice(CUSTOMERS)
            what = R.choice(['Slurry spreading (tanker + operator)', 'Silage harvesting', 'Hedge cutting', 'Round baling + wrapping', 'Reseeding / power harrow', 'Rolling and spreading fertiliser'])
            kind = 'red' if d >= VAT_REG else 'none'
            lag = R.randint(12, 60)
            if R.random() < .04:   # a customer who never pays
                dc = add_doc('sales', d, cust, what, net, kind, 'contracting_income', due=30, rate=0.0 if kind == 'none' else None,
                             flag='UNPAID_SALE', note='never settled; bad debt')
                continue
            dc, t = sale(d, cust, what, net, kind, 'contracting_income', lag=lag, mode=R.choice(['sepa', 'chq']),
                         rate=0.0 if kind == 'none' else None)
        if y in (2014, 2021):
            # supplied in December, invoiced in January: deferring income by one year-end
            d = date(y, 12, R.randint(8, 18))
            net = c(R.choice([2400, 3300, 4100]))
            inv = add_doc('sales', date(y + 1, 1, 4), R.choice(CUSTOMERS), 'Winter slurry spreading, work done in December', net,
                          'red' if y + 1 >= 2015 else 'none', 'contracting_income', supply=d.isoformat(), flag=f'E3-{y}',
                          rate=None if y + 1 >= 2015 else 0.0)
            add_bank('cur', bday(date(y + 1, 1, 22)), 'SEPA CR ' + inv['party'].upper()[:20], inv['gross'], inv['number'], 'contracting_income', 'Y', [inv], flag=f'E3-{y}')
            issue(f'E3-{y}', 'evasion', y, f'Income cut-off: work done {d.isoformat()} but invoice dated {inv["date"].isoformat()}',
                  'Compare supply date to invoice date across the year end; flag income deferred into the next period.')


# ----------------------------------------------------------------------------- payroll and PAYE
EMPLOYEES = [
    ('P. Nowak', 'PPS-EMP-001', date(2008, 3, 1), date(2025, 12, 31), 2300, .035),
    ('S. Coakley (relief milker)', 'PPS-EMP-002', date(2006, 1, 1), date(2025, 12, 31), 520, .035),
    ('A. Brosnan (calving season)', 'PPS-EMP-003', date(2014, 2, 1), date(2025, 7, 31), 1350, .03),
    ('L. Barry', 'PPS-EMP-004', date(2006, 1, 1), date(2008, 2, 29), 1900, .03),
]


def tax_calc(gross):
    paye = max(0, .20 * min(gross, 3500) - 330) + .40 * max(0, gross - 3500)
    usc = .035 * gross
    prsi = .04 * gross
    er = (.085 if gross < 0 else .1075) * gross
    return int(paye), int(usc), int(prsi), int(er)


def run_payroll():
    revenue_due = defaultdict(int)
    for y in range(Y0, Y1 + 1):
        for m in range(1, 13):
            e = eom(y, m)
            tot = 0
            for name, pps, s, f, base, growth in EMPLOYEES:
                if not (s <= e and date(y, m, 1) <= f):
                    continue
                if name.startswith('A. Brosnan') and not (2 <= m <= 8):
                    continue
                g = c(base * (1.0 + growth) ** (y - 2006) * (R.uniform(.97, 1.04) if 'relief' in name else 1))
                paye, usc, prsi, er = tax_calc(g)
                net = g - paye - usc - prsi
                PAYSLIPS.append(dict(period=f'{y}-{m:02d}', employee=name, pps=pps, gross=g, paye=paye, usc=usc, prsi_ee=prsi, prsi_er=er, net=net, paid='bank transfer'))
                tot += paye + usc + prsi + er
                nm = name.split(' (')[0].upper()
                add_bank('cur', bday(date(y, m, 28)), f'SEPA CT WAGES {nm}', -net, f'PAY {y}{m:02d}', 'wages_net', 'Y')
            revenue_due[(y + (m == 12), m % 12 + 1)] += tot
    for (y, m), amt in sorted(revenue_due.items()):
        if y > Y1 or amt == 0:
            continue
        d = date(y, m, 14)
        # 2012: two months paid late with interest
        if (y, m) in ((2012, 6), (2012, 7)):
            continue
        if (y, m) == (2012, 8):
            late = revenue_due[(2012, 6)] + revenue_due[(2012, 7)]
            add_bank('cur', bday(date(2012, 8, 14)), 'REVENUE PAYE/PRSI/USC EMP 4521978', -(late + amt), 'ROS', 'paye_prsi_usc', 'Y', flag='LATE_PAYE', note='June and July paid with August')
            add_bank('cur', bday(date(2012, 8, 14)), 'REVENUE INTEREST ON LATE PAYE', -c(212.40), '', 'revenue_interest', 'Y', flag='LATE_PAYE')
            issue('P1-2012', 'error', 2012, 'June and July PAYE/PRSI paid late, with Revenue interest', 'Detect missing Revenue direct debits for two months and the later catch-up payment.')
            continue
        add_bank('cur', bday(d), 'REVENUE PAYE/PRSI/USC EMP 4521978', -amt, 'ROS', 'paye_prsi_usc', 'Y')
    # duplicate Revenue direct debit
    add_bank('cur', date(2016, 11, 14), 'REVENUE PAYE/PRSI/USC EMP 4521978', -c(R.choice([4100.0])), 'ROS', 'paye_prsi_usc', 'Y', flag='DUP_REVENUE_DD', note='extra debit; refunded to ROS credit later')
    add_bank('cur', date(2017, 3, 2), 'REVENUE REFUND ROS', c(4100.0), 'ROS', 'revenue_refund', 'Y', flag='DUP_REVENUE_DD')
    issue('P2-2016', 'error', 2016, 'Revenue payroll debit taken twice in Nov 2016, refunded in March 2017', 'Pair the duplicate debit with the later refund; do not cost it twice.')

    # unrecorded labour: a worker paid by bank transfer with no payslips, no PAYE, from 2010-2013 and overtime top-ups
    for y in range(2010, 2014):
        for m in range(3, 12):
            add_bank('cur', bday(date(y, m, 15)), 'SEPA CT R KOWALSKI', -c(R.choice([700, 750, 800, 850])), 'LABOUR', 'wages_unrecorded', 'Y', flag='E4-ghost',
                     note='no payslip, not on payroll, no PAYE/PRSI')
    issue('E4', 'evasion', 2010, 'R. Kowalski paid every month Mar-Nov 2010-2013 by transfer: not on payroll, no PAYE/PRSI/USC returned',
          'Recurring payments to a person with no payslips and no Revenue payroll line; flag possible unreported employment.')
    for y in range(2015, 2022):
        for m in (7, 8, 11):
            add_bank('cur', bday(date(y, m, 20)), 'SEPA CT P NOWAK', -c(R.choice([300, 350, 400, 450])), 'OT', 'wages_unrecorded', 'Y', flag='E5-overtime',
                     note='overtime paid on top of net pay outside payroll')
    issue('E5', 'evasion', 2015, 'Employee overtime paid by separate transfers (Jul/Aug/Nov) outside payroll',
          'Second payment to an employee in the same month with no payslip; flag as untaxed pay.')
    # family wages: son
    for y in range(2016, 2020):
        for m in range(1, 13):
            add_bank('cur', bday(date(y, m, 5)), 'SEPA CT C MULLANE', -c(400), 'FARM LABOUR', 'wages_unrecorded', 'N', flag='E6-family-wages',
                     note='son at college; no payroll, no work evidence')
    issue('E6', 'evasion', 2016, 'EUR 400/month to the farmer\'s son (student) 2016-2019 labelled farm labour, no payroll', 'Related-party payments with no payroll record; flag as personal / drawings.')


def run_other_paye_income():
    # Spouse: school bus driver, PAYE, net pay lodged to the farm account, Sept-June, from 2009
    for y in range(2009, Y1 + 1):
        for m in list(range(9, 13)) + list(range(1, 7)):
            if y == 2009 and m < 9:
                continue
            g = c(1700 * (1.03 ** (y - 2009)))
            paye, usc, prsi, er = tax_calc(g)
            net = g - paye - usc - prsi
            PAYSLIPS.append(dict(period=f'{y}-{m:02d}', employee='S. Mullane (spouse) - school transport', pps='PPS-PERS-002', gross=g, paye=paye, usc=usc,
                                 prsi_ee=prsi, prsi_er=er, net=net, paid='lodged to farm account (NOT a farm wage)'))
            add_bank('cur', bday(date(y, m, 25)), 'BUS EIREANN PAYROLL', net, f'PAY{y}{m:02d}', 'personal_paye_income', 'N', note='spouse PAYE, personal income')
    for y in range(2019, Y1 + 1):
        for m in range(1, 13):
            g = c(2300 * (1.04 ** (y - 2019)))
            paye, usc, prsi, er = tax_calc(g)
            net = g - paye - usc - prsi
            PAYSLIPS.append(dict(period=f'{y}-{m:02d}', employee='C. Mullane (son) - agri contractor employee', pps='PPS-PERS-003', gross=g, paye=paye, usc=usc,
                                 prsi_ee=prsi, prsi_er=er, net=net, paid='lodged to farm account (NOT a farm wage)'))
            add_bank('cur', bday(date(y, m, 28)), 'LYONS AGRI CONTRACTING PAYROLL', net, f'PAY{y}{m:02d}', 'personal_paye_income', 'N', note='son PAYE as a contractor employee, personal')
    issue('PAYE-IN', 'info', 2009, 'Spouse (bus driver) and son (contractor employee) net pay lodged to the farm account',
          'Personal PAYE income, not farm turnover. Classify as drawings-in / non-business; match to payslips.')


# ----------------------------------------------------------------------------- grants and schemes
def run_grants():
    for y in range(Y0, Y1 + 1):
        a = c(SFP[y] * R.uniform(.97, 1.03))
        nm = 'DAFF SINGLE FARM PMT' if y < 2015 else 'DAFM BASIC PAYMENT' if y < 2023 else 'DAFM BISS'
        if y < 2015:
            d = bday(date(y, 12, 2))
            add_bank('cur', d, nm, a, f'SFP{y}', 'scheme_income', 'Y')
            add_other('remittance_advice', d, 'DAFM', f'Single Farm Payment {y}', gross=a, net=a, ref=f'SFP{y}')
        else:
            adv, bal = int(a * .75), a - int(a * .75)
            for amt, d, lab in ((adv, bday(date(y, 10, 21)), 'ADVANCE'), (bal, bday(date(y, 12, 5)), 'BALANCE')):
                add_bank('cur', d, f'{nm} {lab}', amt, f'{nm[-4:]}{y}', 'scheme_income', 'Y')
                add_other('remittance_advice', d, 'DAFM', f'{nm} {y} {lab.lower()}', gross=amt, net=amt, ref=f'{nm[-4:]}{y}')
        # ANC
        anc = c(2900 + 8 * (y - 2006))
        add_bank('cur', bday(date(y, 12, 12)), 'DAFM ANC' if y >= 2018 else 'DAFF DISADV AREAS', anc, f'ANC{y}', 'scheme_income', 'Y')
        add_other('remittance_advice', bday(date(y, 12, 12)), 'DAFM', f'Areas of natural constraint {y}', gross=anc, net=anc)
        # agri-environment
        env, ev = ((5600, 'DAFF REPS4'), (4800, 'DAFF AEOS'), (5200, 'DAFM GLAS'), (7200, 'DAFM ACRES'))[0 if y < 2010 else 1 if y < 2015 else 2 if y < 2023 else 3]
        d = bday(date(y, 12, 19))
        add_bank('cur', d, ev, c(env), '', 'scheme_income', 'Y')
        add_other('remittance_advice', d, 'DAFM', f'{ev} payment {y}', gross=c(env), net=c(env))
        if y >= 2023:
            add_bank('cur', bday(date(y, 12, 14)), 'DAFM ECO-SCHEME', c(6200), '', 'scheme_income', 'Y')
        if 2016 <= y <= 2019:
            add_bank('cur', bday(date(y, 12, 7)), 'TEAGASC KT GROUP PMT', c(750), '', 'scheme_income', 'Y')
        # forestry premium: exempt income, paid November
        if 2009 <= y <= 2023:
            add_bank('cur', bday(date(y, 11, 4)), 'DAFM FORESTRY PREMIUM', c(2400), '', 'forestry_premium', 'X', note='exempt from income tax; not a trading receipt')
    issue('FOREST', 'info', 2009, 'Forestry premium lodged each November 2009-2023', 'Exempt income: report separately from trading and from scheme income.')
    # TB compensation, fodder aid
    add_bank('cur', bday(date(2011, 5, 20)), 'DAFF TB COMPENSATION', c(10350), 'TB11', 'tb_compensation', 'Y', note='9 reactors removed')
    REGISTER.append(dict(date=date(2011, 4, 12), event='TB_REACTOR_REMOVAL', head=9, counterparty='DAFF', reference='TB11', notes='herd restricted; compensation paid May'))
    add_bank('cur', bday(date(2019, 3, 8)), 'DAFM TB COMPENSATION', c(18900), 'TB19', 'tb_compensation', 'Y', note='15 reactors removed')
    REGISTER.append(dict(date=date(2019, 1, 29), event='TB_REACTOR_REMOVAL', head=15, counterparty='DAFM', reference='TB19', notes='herd restricted, quarantine until June'))
    add_bank('cur', bday(date(2013, 6, 14)), 'DAFF FODDER HAULAGE SUPPORT 2013', c(1800), 'FOD13', 'scheme_income', 'Y')
    add_bank('cur', bday(date(2018, 10, 25)), 'DAFM FODDER TRANSPORT SUPPORT', c(2400), 'FOD18', 'scheme_income', 'Y')
    # capital receipts / one-offs
    add_bank('cur', date(2012, 9, 6), 'TFR FROM P MULLANE', c(30000), 'GIFT', 'family_gift', 'N', note='parental gift, capital acquisition tax matter, not income')
    add_bank('cur', date(2013, 7, 11), 'ESB NETWORKS WAYLEAVE', c(4200), 'WL13', 'capital_receipt', 'Y', note='one-off easement payment')
    add_bank('cur', date(2014, 4, 3), 'MUNSTER FARM INSURANCE CLAIM', c(18200), 'CL14', 'insurance_claim', 'Y', note='storm damage to shed roof')
    add_bank('cur', date(2017, 8, 24), 'CORK COUNTY COUNCIL COMPENSATION', c(14000), 'CPO17', 'capital_receipt', 'Y', note='road-widening strip')
    add_bank('cur', date(2022, 3, 9), 'MUNSTER FARM INSURANCE CLAIM', c(9400), 'CL22', 'insurance_claim', 'Y', note='storm damage')
    # solar export payments
    for y in range(2022, Y1 + 1):
        for q in (3, 6, 9, 12):
            if y < 2024:
                continue
            amt = c(R.uniform(900, 1700)) if y == 2024 else c(R.uniform(1300, 2100))
            add_bank('cur', bday(date(y, q, 28)), 'ESB CLEAN EXPORT GUARANTEE', amt, '', 'energy_export_income', 'Y')


# ----------------------------------------------------------------------------- capital and finance
def capex(d, sup, desc, net, kind, cat='capital_equipment', parts=((0, 1.0),), pay='sepa', **kw):
    dc = add_doc('purchase', d, sup, desc, net, kind, cat, due=30, **kw)
    docs = [dc]
    for lag, frac in parts:
        amt = int(round(dc['gross'] * frac))
        pd = bday(d + timedelta(days=lag))
        desc_b, ref = pay_desc(sup, pay, pd, docs, amt)
        add_bank('cur', pd, desc_b, -amt, dc['number'] if lag else '', cat, 'Y', docs, note='stage payment' if len(parts) > 1 else '')
    return dc


def amort(principal, annual_rate, months):
    r = annual_rate / 1200
    return principal * r / (1 - (1 + r) ** -months)


LOANS = []


def add_loan(name, d, principal, term_m, ref):
    add_bank('cur', bday(d), f'AIB LOAN DRAWDOWN {ref}', c(principal), ref, 'loan_drawdown', 'Y', note='not income')
    add_other('loan_agreement', d, 'AIB', name, gross=c(principal), ref=ref, note=f'term {term_m} months, variable rate')
    LOANS.append(dict(name=name, start=d, bal=principal, term=term_m, ref=ref))


def run_loans():
    for y in range(Y0, Y1 + 1):
        for m in range(1, 13):
            for L in LOANS:
                if date(y, m, 1) <= L['start'] or L['bal'] < 1:
                    continue
                if y > L['start'].year and m == 1 or (y, m) == (L['start'].year, L['start'].month + 1) or 'pmt' not in L:
                    left = max(1, L['term'] - ((y - L['start'].year) * 12 + m - L['start'].month) + 1)
                    L['pmt'] = amort(L['bal'], LOAN_RATE[y], left)
                interest = L['bal'] * LOAN_RATE[y] / 1200
                pmt = min(L['pmt'], L['bal'] + interest)
                L['bal'] -= (pmt - interest)
                add_bank('cur', bday(date(y, m, 8)), f'D/D AIB LOAN {L["ref"]}', -c(pmt), L['ref'], 'loan_repayment', 'Y',
                         note=f'interest {interest:.2f}, capital {pmt - interest:.2f}')
                ANNUAL[y]['loan_interest'] = ANNUAL[y].get('loan_interest', 0) + c(interest)


def run_capital():
    cap = []
    vr = 'red'
    # 2006-2014 are flat-rate years: VAT printed but not recoverable
    capex(date(2006, 5, 10), 'milksys', 'Bulk milk tank 8,000L, replacement', c(14200), 'std', parts=((20, 1.0),))
    add_loan('Shed extension loan', date(2007, 4, 12), 120000, 120, 'L01')
    capex(date(2007, 3, 20), 'build', 'Cubicle shed extension, 100 cubicles, labour and materials', c(118000), 'red', parts=((15, .3), (60, .4), (110, .3)), pay='chq')
    capex(date(2007, 4, 2), 'steel', 'Steel fabrication: gates, feed barrier, cubicle divisions', c(22000), 'std', parts=((30, 1.0),), pay='chq')
    add_bank('cur', bday(date(2007, 12, 6)), 'DAFF FARM INVESTMENT SCHEME', c(48000), 'FIS07', 'capital_grant', 'Y', note='40% grant on eligible shed cost')
    add_other('remittance_advice', date(2007, 12, 6), 'DAFF', 'Farm investment scheme grant', gross=c(48000), net=c(48000))
    capex(date(2008, 4, 15), 'tractors', 'New 100hp tractor, less trade-in EUR 18,000', c(82000 - 18000), 'std', parts=((7, 1.0),), pay='chq',
          note='trade-in credited on invoice')
    REGISTER.append(dict(date=date(2008, 4, 15), event='ASSET_TRADE_IN', head=1, counterparty=pname('tractors'), reference='', notes='old tractor traded in at EUR 18,000'))
    capex(date(2010, 6, 8), 'milksys', 'Parlour upgrade 24 to 30 units with automatic cluster removers', c(58000), 'std', parts=((10, .5), (45, .5)), pay='chq')
    capex(date(2010, 7, 2), 'milksys', 'Plate cooler and variable-speed vacuum pump (energy efficient equipment)', c(8500), 'std', parts=((30, 1.0),), pay='chq',
          note='accelerated capital allowance candidate')
    add_bank('cur', bday(date(2011, 2, 18)), 'DAFF TAMS GRANT', c(23200), 'TAMS10', 'capital_grant', 'Y')
    # 2010 cheque with no invoice
    t = add_bank('cur', bday(date(2010, 11, 12)), 'CHQ %06d' % (_seq.__setitem__('chq', _seq['chq'] + 2) or _seq['chq']), -c(8500), '', 'capital_equipment', 'Y', flag='MISSING_INVOICE',
                 note='cheque to machinery dealer, no invoice on file; stub says "shed"')
    issue('M1-2010', 'omission', 2010, 'EUR 8,500 capital cheque with no invoice', 'Payment with no document: no input VAT or capital allowance until evidenced.')
    capex(date(2012, 3, 14), 'motors', 'Toyota Land Cruiser, farm jeep, registration 12-C', c(38000), 'std', 'motor_vehicle', parts=((5, 1.0),), pay='chq', biz='M', deductible=False,
          note='passenger car: 50% private use claimed in the books; input VAT never reclaimable')
    capex(date(2013, 5, 3), 'motors', 'Skoda Octavia Estate, 13-C, family car', c(24500), 'std', 'family_car', parts=((3, 1.0),), pay='chq', biz='N', deductible=False,
          flag='E7-car', description_override=None) if False else None
    dcar = add_doc('purchase', date(2013, 5, 3), 'motors', 'Skoda Octavia Estate 13-C. Farm vehicle (advisory visits)', c(24500), 'std', 'family_car', biz='N', deductible=False, flag='E7-car',
                   note='family car invoiced as a farm vehicle')
    add_bank('cur', bday(date(2013, 5, 6)), 'CHQ %06d' % (_seq.__setitem__('chq', _seq['chq'] + 1) or _seq['chq']), -dcar['gross'], '', 'family_car', 'N', [dcar], flag='E7-car')
    issue('E7-2013', 'evasion', 2013, 'Family car (EUR 24,500 + VAT) paid from the farm account and described as a farm vehicle', 'Personal asset: classify as drawings, no capital allowances, no VAT; review item on a car described as farm use.')
    capex(date(2014, 12, 9), 'tractors', 'Slurry tanker 3,000 gal with trailing shoe', c(24000), 'std', parts=((20, 1.0),), pay='chq')
    # 2015 expansion
    add_loan('Expansion term loan', date(2015, 2, 20), 400000, 180, 'L02')
    capex(date(2015, 2, 12), 'milksys', 'New 40-unit herringbone parlour with ACR and meal feeders', c(165000), 'std', parts=((7, .35), (60, .4), (120, .25)))
    capex(date(2015, 3, 5), 'build', 'Cubicle house 150 cubicles, concrete, roofing', c(210000), 'red', parts=((10, .3), (70, .4), (130, .3)))
    capex(date(2015, 4, 20), 'obrien', 'Roadways, paddock fencing and water system', c(45000), 'red', parts=((30, 1.0),))
    capex(date(2015, 6, 11), 'build', 'Slurry storage 1,200 m3', c(185000), 'red', parts=((15, .5), (75, .5)))
    capex(date(2015, 8, 3), 'milksys', 'Bulk tank 14,000L with pre-cooler', c(21000), 'std', parts=((14, 1.0),))
    add_bank('cur', bday(date(2015, 12, 3)), 'DAFM TAMS II GRANT', c(64000), 'TAMS15A', 'capital_grant', 'Y', note='40% on ceiling for buildings')
    add_other('remittance_advice', date(2015, 12, 3), 'DAFM', 'TAMS II grant buildings', gross=c(64000), net=c(64000))
    add_bank('cur', bday(date(2016, 4, 14)), 'DAFM TAMS II GRANT', c(32000), 'TAMS15B', 'capital_grant', 'Y', note='40% on dairy equipment')
    add_other('remittance_advice', date(2016, 4, 14), 'DAFM', 'TAMS II grant dairy equipment', gross=c(32000), net=c(32000))
    # TAMS inflation: dealer invoice inflated by 9,000; dealer refunds in cash lodged later
    inf = capex(date(2016, 1, 15), 'steel', 'Slurry stirring, agitation pumps, pipework', c(31000), 'std', parts=((20, 1.0),), flag='E8-tams', note='invoice inflated, EUR 7,500 returned in cash')
    add_bank('cur', bday(date(2016, 3, 2)), 'CASH LODGEMENT', c(7500), '', 'unexplained_credit', 'U', flag='E8-tams', note='cash rebate from the fabricator')
    issue('E8-2016', 'evasion', 2016, 'Fabricator invoice EUR 31,000 +VAT claimed for grant; EUR 7,500 comes back as a cash lodgement',
          'Round cash lodgement within weeks of a supplier payment: flag a rebate that undermines the invoice amount used for a grant claim.')
    capex(date(2016, 9, 6), 'tractors', 'Tractor 120hp with loader', c(96000), 'std', parts=((7, 1.0),), pay='sepa')
    add_bank('cur', bday(date(2016, 9, 28)), 'CASH LODGEMENT', c(28500), '', 'asset_sale_proceeds', 'Y', note='sale of old 100hp tractor, private sale, no invoice')
    issue('M2-2016', 'omission', 2016, 'Sale of the 2008 tractor for EUR 28,500 with no sales invoice', 'Disposal proceeds with no document; balancing allowance/charge not computable.')
    dhz = capex(date(2016, 3, 21), 'motors', 'Toyota Hilux double cab 4x4', c(41000), 'std', 'motor_vehicle', parts=((4, 1.0),), pay='sepa', biz='M', deductible=False,
                note='double-cab pickup: input VAT restriction applies', flag='M3-vat')
    # 2017
    capex(date(2017, 5, 18), 'milksys', 'Heat detection collars, 300 units + base station', c(22000), 'std', parts=((10, 1.0),))
    capex(date(2017, 9, 7), 'build', 'Calf shed 40 pens, with feed alley', c(38000), 'red', parts=((20, .5), (60, .5)))
    # 2018 land
    add_loan('Land purchase loan', date(2018, 5, 9), 200000, 240, 'L03')
    land = 235000
    add_bank('cur', bday(date(2018, 5, 14)), 'SEPA CT FITZGERALD & CO CLIENT A/C', -c(land), 'LAND', 'land_purchase', 'Y', note='25 acres purchase price, no VAT')
    add_other('solicitor_completion', date(2018, 5, 14), pname('sol'), 'Completion statement: 25 acres, folio CK12345', gross=c(land))
    add_bank('cur', bday(date(2018, 5, 14)), 'REVENUE STAMP DUTY 1%', -c(land * .01), 'LAND', 'stamp_duty', 'Y', note='capital, part of the cost of land')
    purchase(date(2018, 5, 16), 'sol', 'Legal fees: land purchase and conveyance', c(3800), 'std', 'professional_fees', 'sepa', 4)
    purchase(date(2018, 2, 15), 'sol', 'Legal fees: land purchase and conveyance (supplementary)', c(1250), 'std', 'professional_fees', 'sepa', 9) if False else None
    # 2019-2022 automation
    capex(date(2019, 3, 4), 'milksys', 'Automatic calf feeder, 2 stations, with software', c(16500), 'std', parts=((10, 1.0),))
    capex(date(2019, 7, 15), 'solar', 'Roof solar PV 9.9 kWp, supply and install', c(11800), 'std', parts=((14, 1.0),), note='first PV array; accelerated allowance candidate')
    # TAMS duplicate: slurry tanker claimed twice
    capex(date(2019, 10, 2), 'tractors', 'Slurry tanker 4,000 gal + LESS trailing shoe', c(33500), 'std', parts=((15, 1.0),), flag='E9-dupclaim', number='MT19-0388')
    add_bank('cur', bday(date(2020, 2, 11)), 'DAFM TAMS II GRANT', c(13400), 'TAMS19L', 'capital_grant', 'Y', flag='E9-dupclaim', note='40% LESS grant')
    add_bank('cur', bday(date(2020, 9, 17)), 'DAFM TAMS II GRANT', c(13400), 'TAMS19L2', 'capital_grant', 'Y', flag='E9-dupclaim', note='same invoice claimed again')
    issue('E9-2019', 'evasion', 2019, 'The same slurry tanker invoice (MT19-0388) triggers two identical grant payments', 'Duplicate grant income against one invoice: flag the second payment and the invoice reuse.')
    capex(date(2020, 4, 28), 'tractors', 'Loading shovel', c(58000), 'std', parts=((10, 1.0),))
    capex(date(2020, 8, 3), 'milksys', 'Slurry scraper robot', c(17500), 'std', parts=((14, 1.0),))
    capex(date(2021, 3, 9), 'milksys', 'Automatic feed pusher robot', c(31000), 'std', parts=((20, 1.0),))
    capex(date(2021, 10, 5), 'milksys', 'Auto-drafting gates and herd sensor system', c(14500), 'std', parts=((20, 1.0),))
    capex(date(2022, 4, 5), 'milksys', 'Parlour automation: auto wash and in-parlour feeding refit', c(36000), 'std', parts=((15, 1.0),))
    # HP tractor
    d = date(2022, 10, 6)
    dc = add_doc('purchase', d, 'tractors', 'Tractor 130hp, supplied on hire purchase', c(145000), 'std', 'capital_equipment', number='MT22-0719')
    add_bank('cur', bday(d + timedelta(days=5)), 'SEPA CT SOUTHERN ASSET FINANCE', -c(30000), 'HP DEPOSIT', 'hp_deposit', 'Y', [dc], note='deposit; balance financed by the lender')
    add_other('hp_agreement', d, pname('finance'), 'HP agreement 48 months', gross=c(145000 * 1.23 - 30000), ref='HP22-0719', note='monthly 2,950 incl. interest')
    for k in range(48):
        dd = date(2022 + (10 + k) // 12, (10 + k) % 12 + 1, 18)
        if dd <= END:
            add_bank('cur', bday(dd), 'D/D SOUTHERN ASSET FINANCE', -c(2950), 'HP22-0719', 'hp_repayment', 'Y', note='capital plus finance charge')
    # 2023 low-emission slurry
    capex(date(2023, 5, 22), 'tractors', 'Umbilical slurry system and dribble bar', c(27000), 'std', parts=((20, 1.0),))
    # solar 2024: invoice inflated for grant
    sdoc = capex(date(2024, 3, 6), 'solar', 'Solar PV 49.9 kWp, inverters, install, grid connection', c(98000), 'red', parts=((10, .3), (50, .7)), flag='E10-solar',
                 note='printed price is inflated by EUR 8,000 vs what was paid', cat='solar_pv')
    add_bank('cur', bday(date(2024, 6, 26)), 'CASH LODGEMENT', c(8000), '', 'unexplained_credit', 'U', flag='E10-solar', note='cash rebate from installer')
    add_bank('cur', bday(date(2024, 9, 12)), 'DAFM SOLAR CAPITAL INVESTMENT SCHEME', c(54000), 'SCIS24', 'capital_grant', 'Y', note='60% on ceiling EUR 90,000')
    add_other('remittance_advice', date(2024, 9, 12), 'DAFM', 'Solar capital investment scheme grant', gross=c(54000), net=c(54000))
    issue('E10-2024', 'evasion', 2024, 'Solar installer invoice (EUR 98,000 + VAT) used for the grant; EUR 8,000 cash comes back', 'Same pattern as E8: round cash lodgement after the installer is paid.')
    capex(date(2025, 4, 8), 'solar', 'Battery storage 30 kWh with energy management', c(19500), 'red', parts=((15, 1.0),), cat='solar_pv')
    # Weekend away and tour (E11)
    for y, nm, net, sup in ((2012, 'Dairy study tour: Portugal, 5 nights, 2 delegates (golf and spa package)', 4850, 'resort'),
                           (2016, 'Farm management seminar and accommodation (4 nights)', 3900, 'hotel'),
                           (2019, 'Dairy conference and delegate package, Algarve', 5200, 'resort')):
        d = date(y, 6, R.randint(5, 20))
        dc = add_doc('purchase', d, sup, nm, c(net), 'std' if sup == 'hotel' else 'none', 'family_holiday', biz='N', deductible=False, flag='E11-holiday',
                     vat=0 if sup == 'resort' else None)
        add_bank('cur', bday(d + timedelta(days=3)), 'POS ' + pname(sup).upper()[:20], -dc['gross'], '', 'family_holiday', 'N', [dc], flag='E11-holiday')
        issue(f'E11-{y}', 'evasion', y, f'Family holiday invoiced as a study tour / seminar ({nm})', 'Hospitality/accommodation with golf/spa wording in the farm books; non-deductible, no input VAT.')
    # ghost supplier near year end (E12)
    for y in range(2010, 2014):
        for k in range(2):
            d = date(y, 12, R.randint(12, 28))
            amt = c(R.choice([4000, 5000, 3500, 4500]))
            dc = add_doc('purchase', d, 'ghost', 'Labour and plant hire as agreed', amt, 'none', 'ghost_supplier', vatno_ok=False, flag='E12-ghost', vat=0,
                         number=f'PC-{R.randint(100, 999)}', note='no VAT number, round sums, no work evidence')
            add_bank('cur', bday(d + timedelta(days=R.randint(1, 5))), 'CHQ %06d' % (_seq.__setitem__('chq', _seq['chq'] + R.randint(1, 3)) or _seq['chq']), -amt, '', 'ghost_supplier', 'N', [dc], flag='E12-ghost')
    issue('E12', 'evasion', 2010, 'P. Crowley Plant & Labour: round-sum invoices in mid/late December 2010-2013, no VAT number, cheques paid immediately',
          'Round-sum year-end invoices from a supplier with no VAT number and no other trading: flag as a possible fictitious expense.')
    # fertiliser prepayment (E13: expense pulled into the wrong year)
    for y in (2021, 2022):
        d = date(y, 12, 29)
        net = c(32000 if y == 2021 else 41000)
        dc = add_doc('purchase', d, 'fert', 'CAN and protected urea, to be delivered March ' + str(y + 1), net, 'red', 'fertiliser', flag='E13-cutoff', supply=date(y + 1, 3, 10).isoformat())
        add_bank('cur', bday(date(y, 12, 30)), 'SEPA CT KILCUMMIN AGRI SUPPLIES', -dc['gross'], dc['number'], 'fertiliser', 'Y', [dc], flag='E13-cutoff')
        issue(f'E13-{y}', 'evasion', y, f'EUR {net / 100:,.0f} fertiliser invoiced and paid on 29 Dec {y} for delivery in March {y + 1}', 'Supply date after the period end: a prepayment, not a cost of this year.')


# ----------------------------------------------------------------------------- personal spending and Revenue
def run_personal():
    for y in range(Y0, Y1 + 1):
        k = CPI[y] / 100
        # drawings and ATM
        draw = c((1700 + 120 * (y - 2006)) * (0.75 if y in (2009, 2016, 2023) else 1.0))
        for m in range(1, 13):
            add_bank('cur', bday(date(y, m, 1)), 'STO T MULLANE', -draw, '', 'drawings', 'N')
            for w in range(R.randint(3, 5)):
                add_bank('cur', rdate(y, m), 'ATM WITHDRAWAL', -c(R.choice([150, 200, 250, 300])), '', 'drawings', 'N')
            # groceries
            for w in range(R.randint(4, 6)):
                shop = R.choice(['SUPERVALU', 'DUNNES STORES', 'TESCO IRELAND', 'LIDL', 'ALDI'])
                amt = c(R.uniform(75, 230) * k)
                cashback = R.choice([0, 0, 0, 40, 60, 100])
                desc = f'POS {shop} CHARLEVILLE' + (f' incl cashback {cashback:.2f}' if cashback else '')
                add_bank('cur', rdate(y, m), desc, -(amt + c(cashback)), '', 'personal_groceries', 'N', note='household spending')
            if R.random() < .7:
                add_bank('cur', rdate(y, m), 'POS APPLEGREEN CHARLEVILLE', -c(R.uniform(55, 95) * k), '', 'family_fuel', 'N')
            if R.random() < .35:
                add_bank('cur', rdate(y, m), 'POS ' + R.choice(['PHARMACY CHARLEVILLE', 'GAA CLUB LOTTO', 'RESTAURANT CORK', 'PENNEYS', 'COSTA COFFEE']), -c(R.uniform(15, 140) * k), '', 'personal_misc', 'N')
            add_bank('cur', bday(date(y, m, 12)), 'D/D HEALTH INSURANCE', -c(380 * k), '', 'health_insurance', 'N')
            add_bank('cur', bday(date(y, m, 20)), 'STO ST MARYS CREDIT UNION', -c(200), '', 'savings', 'N')
            add_bank('cur', bday(date(y, m, 5)), 'D/D PRSA PENSION', -c(500 * k), '', 'pension_personal', 'N', note='personal pension; relief claimed on the personal return')
            add_bank('cur', bday(date(y, m, 22)), 'D/D SKY / NETFLIX / TV', -c(70 * k), '', 'personal_misc', 'N')
        add_bank('cur', bday(date(y, 9, 5)), 'POS SCHOOL UNIFORMS AND BOOKS', -c(1100 * k), '', 'personal_education', 'N')
        add_bank('cur', bday(date(y, 7, 14)), 'POS AER LINGUS / BOOKING.COM', -c(R.uniform(3200, 5200) * k), '', 'family_holiday', 'N', note='family holiday paid by the farm account')
        add_bank('cur', bday(date(y, 12, 10)), 'POS ARNOTTS / PENNEYS / TOYS', -c(R.uniform(900, 1700) * k), '', 'personal_misc', 'N')
        add_bank('cur', bday(date(y, 5, 8)), 'D/D MOTOR TAX + CAR INSURANCE', -c(1200 * k), '', 'family_car_running', 'N')
        if y >= 2016:
            add_bank('cur', bday(date(y, 8, 22)), 'SEPA CT UCC FEES', -c(3000), 'CIAN', 'personal_education', 'N')
        # tax paid personally from business funds
        add_bank('cur', bday(date(y, 10, 31)), 'REVENUE INCOME TAX BAL + PRELIM', -c((16000 + 900 * (y - 2006)) * (0.5 if y in (2009, 2016, 2023) else 1)), 'ROS', 'personal_tax', 'N',
                 note='farmer income tax: personal liability, not a farm expense')
    add_bank('cur', date(2020, 5, 8), 'POS TESCO IRELAND', -c(412.30), '', 'personal_groceries', 'N', flag='E14-vat-grocery', note='receipt filed in the farm VAT folder')
    dpx = add_doc('purchase', date(2020, 5, 8), 'tesco', 'Groceries, household and farm kitchen', c(335.20), 'std', 'personal_groceries', biz='N', deductible=False, flag='E14-vat-grocery')
    BANK['cur'][-1]['docs'] = [dpx['id']]
    issue('E14-2020', 'evasion', 2020, 'A supermarket receipt posted as a farm purchase with input VAT claimed', 'Personal groceries: not a business expense; no input VAT.')
    # a deliberate cash-basis nuisance: also hotel of own wedding anniversary etc.
    add_other('note', date(2025, 12, 31), 'Mullane Dairy Farm', 'Statement coverage 2006-01-01 to 2025-12-31')


# ----------------------------------------------------------------------------- the random errors and omissions layered on
def run_errors():
    # supplier invoices with wrong arithmetic, wrong VAT rate, missing VAT number, credit notes, duplicates
    cand = [d for d in DOCS if d['direction'] == 'purchase' and d['cat'] in ('feed', 'fertiliser', 'repairs', 'vet_medicine', 'contractors') and d['date'].year >= 2007]
    R.shuffle(cand)
    for i, d in enumerate(cand[:5]):
        d['gross'] += R.choice([10, 20, 100, -10, -100])
        d['flag'] = (d['flag'] + ';' if d['flag'] else '') + 'ARITH_ERROR'
        d['note'] = 'printed gross does not equal net + VAT'
    issue('ARITH', 'error', 2006, '5 invoices whose printed gross is not net + VAT (by 10c-1.00)', 'Cross-check and raise a review item; do not silently correct.')
    for d in cand[5:10]:
        d['vat'] = int(round(d['net'] * .23))
        d['gross'] = d['net'] + d['vat']
        d['flag'] = (d['flag'] + ';' if d['flag'] else '') + 'WRONG_VAT_RATE'
        d['note'] = 'VAT charged at 23% on a 13.5% / 0% item'
        for t in BANK['cur']:
            if d['id'] in t['docs'] and len(t['docs']) == 1:
                t['amt'] = -d['gross']
    issue('WRONGVAT', 'error', 2006, '5 invoices charged at 23% where 13.5% or 0% applies', 'Compare printed VAT to the rate for the supply; do not reclaim more input VAT than is due.')
    for d in cand[10:16]:
        d['partyvat'] = ''
        d['flag'] = (d['flag'] + ';' if d['flag'] else '') + 'NO_VAT_NUMBER'
        d['deductible'] = False
    issue('NOVATNO', 'omission', 2015, '6 invoices with no supplier VAT number on them', 'Input VAT is not claimable without a valid invoice (reg. 20 particulars).')
    # duplicate resends
    for d in cand[16:22]:
        _seq['d'] += 1
        dup = dict(d)
        dup['id'] = f'D{_seq["d"]:05d}'
        dup['date'] = d['date'] + timedelta(days=R.randint(6, 25))
        dup['flag'] = 'DUPLICATE_INVOICE'
        dup['note'] = f'resent copy of {d["number"]}'
        DOCS.append(dup)
    issue('DUPINV', 'error', 2006, '6 supplier invoices that appear twice (same number, resent weeks later)', 'Duplicate invoice number from one supplier: do not post twice.')
    # credit notes
    for d in cand[22:32]:
        _seq['d'] += 1
        cn = dict(d)
        cn['id'] = f'D{_seq["d"]:05d}'
        cn['typ'] = 'credit_note'
        cn['number'] = 'CN-' + d['number']
        cn['date'] = d['date'] + timedelta(days=R.randint(10, 40))
        k = R.choice([.1, .2, .35])
        cn['net'] = int(d['net'] * k)
        cn['vat'] = int(d['vat'] * k)
        cn['gross'] = cn['net'] + cn['vat']
        cn['desc'] = 'Credit note: returned / short delivered goods against ' + d['number']
        cn['flag'] = 'CREDIT_NOTE'
        DOCS.append(cn)
        if R.random() < .5 and cn['date'] <= END:
            add_bank('cur', bday(cn['date'] + timedelta(days=R.randint(8, 30))), 'SEPA CR ' + d['party'].upper()[:22] + ' REFUND', cn['gross'], cn['number'], d['cat'], 'Y', [cn], flag='CREDIT_NOTE')
    issue('CN', 'info', 2006, '10 credit notes; about half refunded by bank, the rest netted off later payments', 'Credit notes positive as printed; refunded vs unrefunded.')
    # double payments and transposed amounts on supplier payments
    pays = [t for t in BANK['cur'] if t['amt'] < 0 and t['cat'] in ('feed', 'fertiliser', 'contractors', 'vet_medicine', 'repairs') and len(t['docs']) == 1 and t['date'].year >= 2008]
    R.shuffle(pays)
    for t in pays[:4]:
        nd = add_bank('cur', t['date'] + timedelta(days=R.randint(2, 9)), t['desc'], t['amt'], t['ref'], t['cat'], 'Y', [], flag='DOUBLE_PAYMENT', note='invoice paid twice')
        nd['docs'] = list(t['docs'])
        add_bank('cur', bday(t['date'] + timedelta(days=R.randint(35, 70))), 'SEPA CR ' + t['desc'][8:34] + ' REFUND', -t['amt'], '', t['cat'], 'Y', [], flag='DOUBLE_PAYMENT_REFUND')
    issue('DOUBLEPAY', 'error', 2008, '4 supplier invoices paid twice, refunded 5-10 weeks later', 'Second payment for the same invoice is a receivable, not a cost.')
    for t in pays[4:9]:
        a = abs(t['amt'])
        s = list(str(a))
        if len(s) > 4:
            i = len(s) - 4
            s[i], s[i + 1] = s[i + 1], s[i]
            na = int(''.join(s))
            if na != a:
                t['amt'] = -na
                t['flag'] = 'TRANSPOSED_DIGITS'
                t['note'] = f'paid {na / 100:.2f} against invoice {a / 100:.2f}'
    issue('TRANSPOSE', 'error', 2008, '5 payments with two digits swapped against the invoice amount', 'Near-match with an exact-digits transposition: flag, do not auto-settle.')
    # wrong references on payments
    for t in pays[9:14]:
        t['ref'] = 'INV' + str(R.randint(1000, 9999))
        t['flag'] = (t['flag'] + ';' if t['flag'] else '') + 'WRONG_REF'
    issue('WRONGREF', 'error', 2008, '5 payments carrying the reference of an invoice that is not the one paid', 'Prefer amount/date/supplier over a conflicting reference; flag.')
    # returned customer cheque
    cust = [t for t in BANK['cur'] if t['cat'] == 'contracting_income' and 'CHQ' in t['desc'] and t['date'].year >= 2013]
    for t in cust[:2]:
        add_bank('cur', t['date'] + timedelta(days=R.randint(4, 8)), 'CHQ RETURNED UNPAID', -t['amt'], t['ref'], 'contracting_income', 'Y', [], flag='RETURNED_CHEQUE')
        add_bank('cur', t['date'] + timedelta(days=R.randint(4, 8)), 'RETURNED ITEM FEE', -c(15), '', 'bank_charges', 'Y', flag='RETURNED_CHEQUE')
        _ = t
    issue('RETURNED', 'error', 2013, '2 customer cheques returned unpaid after being lodged', 'Reverse the receipt; the sales invoice reopens.')
    # bank error: charge twice then refunded
    for y in (2011, 2018):
        d = bday(date(y, 5, 31))
        add_bank('cur', d, 'TRANSACTION CHARGES Q2', -c(48.5), '', 'bank_charges', 'Y')
        add_bank('cur', d, 'TRANSACTION CHARGES Q2', -c(48.5), '', 'bank_charges', 'Y', flag='BANK_ERROR')
        add_bank('cur', bday(date(y, 6, 20)), 'BANK ERROR CORRECTION', c(48.5), '', 'bank_charges', 'Y', flag='BANK_ERROR')
    issue('BANKERR', 'error', 2011, 'Bank charged a fee twice, reversed three weeks later', 'Net to nil; do not treat as income.')
    # GBP supplier paid by card
    for y in (2016, 2017, 2018, 2019):
        for k in range(2):
            d = rdate(y, R.randint(2, 11))
            gbp = round(R.uniform(180, 760), 2)
            dc = add_doc('purchase', d, 'uk', 'Spare parts for milking equipment (shipped from UK)', c(gbp), 'zero', 'repairs', ccy='GBP', vat=0, flag='GBP_INVOICE')
            fx = 1.18 if y < 2019 else 1.12
            amt = c(gbp * fx)
            add_bank('cur', bday(d + timedelta(days=2)), 'POS YORKSHIRE DAIRY SPARES GBP %.2f' % gbp, -(amt + c(2.5)), '', 'repairs', 'Y', [dc], flag='GBP_INVOICE', note='includes foreign exchange fee')
    issue('GBP', 'info', 2016, '8 invoices in GBP paid by card in EUR with FX fee', 'Foreign-currency purchase: EUR amount comes from the bank line, not the invoice.')
    # unpaid-long-time invoices
    for d in [x for x in DOCS if x['direction'] == 'purchase' and x['cat'] in ('repairs', 'vet_medicine') and 2009 < x['date'].year < 2024][:0]:
        pass


def run_vat_returns():
    periods = [(1, 2), (3, 4), (5, 6), (7, 8), (9, 10), (11, 12)]
    for y in range(2015, Y1 + 1):
        for a, b in periods:
            s, e = date(y, a, 1), eom(y, b)
            sales = [d for d in DOCS if d['direction'] == 'sales' and s <= d['date'] <= e and d['flag'] not in ('UNPAID_SALE',)]
            purch = [d for d in DOCS if d['direction'] == 'purchase' and s <= d['date'] <= e and d['flag'] != 'DUPLICATE_INVOICE']
            t1 = sum(x['vat'] * (-1 if x['typ'] == 'credit_note' else 1) for x in sales)
            t2 = sum(x['vat'] * (-1 if x['typ'] == 'credit_note' else 1) for x in purch)
            due = date(e.year + (b == 12), b % 12 + 1, 19)
            net = t1 - t2
            add_other('vat3_return', due, 'Revenue', f'VAT3 {MON[a - 1]}-{MON[b - 1]} {y}: T1 {eur(t1)} T2 {eur(t2)}', gross=net, net=net, ref=f'VAT3 {y}-{a:02d}',
                      note='as filed: includes VAT on every purchase invoice, including cars and personal items')
            pd = bday(due)
            if (y, a) == (2018, 3):
                pd = bday(due + timedelta(days=44))
                add_bank('cur', pd, 'REVENUE INTEREST VAT', -c(63.2), '', 'revenue_interest', 'Y', flag='LATE_VAT')
                issue('V1-2018', 'error', 2018, 'VAT3 Mar-Apr 2018 paid 6 weeks late with interest', 'Compare VAT payment date to due date.')
            if net >= 0:
                add_bank('cur', pd, f'REVENUE VAT3 {MON[a - 1]}-{MON[b - 1]} {y % 100:02d}', -net, f'VAT3 {y}-{a:02d}', 'vat_payment', 'Y')
            else:
                add_bank('cur', bday(due + timedelta(days=R.randint(8, 30))), f'REVENUE VAT REPAYMENT {MON[a - 1]}-{MON[b - 1]} {y % 100:02d}', -net, f'VAT3 {y}-{a:02d}', 'vat_refund', 'Y')
            ANNUAL[y]['vat_t1'] = ANNUAL[y].get('vat_t1', 0) + t1
            ANNUAL[y]['vat_t2_as_filed'] = ANNUAL[y].get('vat_t2_as_filed', 0) + t2
            wrongly = sum(x['vat'] for x in purch if not x['deductible'] and x['typ'] != 'credit_note')
            ANNUAL[y]['vat_t2_not_deductible'] = ANNUAL[y].get('vat_t2_not_deductible', 0) + wrongly
    issue('E15', 'evasion', 2015, 'VAT3 T2 includes input VAT on cars, hospitality-type invoices, groceries, ghost-supplier and no-VAT-number invoices',
          'T2 must sum recoverable VAT only; quantify the over-claim by year.')
    issue('E16', 'evasion', 2016, 'Cash contracting income never invoiced, so no output VAT in T1', 'Under-declared T1 that matches the unexplained cash lodgements (E2).')


# ----------------------------------------------------------------------------- cash simulation (deposit sweeps, overdraft, balances)
def simulate_cash():
    cur = sorted(BANK['cur'], key=lambda t: (t['date'], t['tid']))
    bymonth = defaultdict(list)
    for t in cur:
        bymonth[(t['date'].year, t['date'].month)].append(t)
    out_cur, out_dep = [], []
    bal = c(18500)
    dep = c(42000)
    opening_cur, opening_dep = bal, dep
    for y in range(Y0, Y1 + 1):
        for m in range(1, 13):
            rows = sorted(bymonth.get((y, m), []) + FUTURE.pop((y, m), []), key=lambda t: (t['date'], t['tid']))
            for t in rows:
                bal += t['amt']
                t['bal'] = bal
                out_cur.append(t)
            e = eom(y, m)
            e = e - timedelta(days=(e.weekday() - 4) if e.weekday() >= 5 else 0)
            if bal < 0:
                it = c(-bal / 100 * LOAN_RATE[y] / 100 / 12 * 1.9)
                t = add_bank('cur', e, 'OVERDRAFT INTEREST', -it, '', 'bank_interest', 'Y')
                BANK['cur'].remove(t) if t in BANK['cur'] else None
                bal -= it
                t['bal'] = bal
                out_cur.append(t)
            if bal > c(70000):
                amt = int((bal - c(35000)) / c(1000)) * c(1000)
                t = add_bank('cur', e, 'TFR TO DEPOSIT ACCT', -amt, '', 'own_transfer', 'T')
                BANK['cur'].remove(t) if t in BANK['cur'] else None
                bal -= amt
                t['bal'] = bal
                out_cur.append(t)
                dep += amt
                out_dep.append(dict(date=e, desc='TFR FROM CURRENT ACCT', amt=amt, bal=dep, cat='own_transfer', tid=t['tid'], note=''))
            elif bal < -c(25000) and dep > c(1000):
                amt = min(dep, int((-bal + c(15000)) / c(1000)) * c(1000))
                t = add_bank('cur', e, 'TFR FROM DEPOSIT ACCT', amt, '', 'own_transfer', 'T')
                BANK['cur'].remove(t) if t in BANK['cur'] else None
                bal += amt
                t['bal'] = bal
                out_cur.append(t)
                dep -= amt
                out_dep.append(dict(date=e, desc='TFR TO CURRENT ACCT', amt=-amt, bal=dep, cat='own_transfer', tid=t['tid'], note=''))
            elif bal < -c(130000):
                # last resort: an unarranged term-loan top-up
                amt = c(80000)
                nm = f'L9{y % 100}{m:02d}'
                t = add_bank('cur', e, f'AIB LOAN DRAWDOWN {nm}', amt, nm, 'loan_drawdown', 'Y', note='working capital term loan, not income')
                BANK['cur'].remove(t) if t in BANK['cur'] else None
                bal += amt
                t['bal'] = bal
                out_cur.append(t)
                add_other('loan_agreement', e, 'AIB', 'Working capital term loan', gross=amt, ref=nm, note='48 months')
                pm = c(amort(amt / 100, LOAN_RATE[y], 48) )
                for k in range(1, 49):
                    yy, mm = y + (m - 1 + k) // 12, (m - 1 + k) % 12 + 1
                    if yy <= Y1:
                        _seq['t'] += 1
                        FUTURE[(yy, mm)].append(dict(tid=_seq['t'], acct='cur', date=bday(date(yy, mm, 9)), desc=f'D/D AIB LOAN {nm}', amt=-pm, ref=nm,
                                                     cat='loan_repayment', biz='Y', docs=[], flag='', note=''))
            if m == 12:
                interest = int(dep * .018)
                if dep > 0:
                    dirt = int(interest * .33)
                    dep += interest - dirt
                    out_dep.append(dict(date=e, desc='DEPOSIT INTEREST (DIRT DEDUCTED)', amt=interest - dirt, bal=dep, cat='deposit_interest', tid=0,
                                        note=f'gross {interest / 100:.2f}, DIRT {dirt / 100:.2f}'))
    # month-end sweep txns on the same last date sort after the month's rows; re-sort final
    out_cur.sort(key=lambda t: (t['date'], t['tid']))
    run = c(18500)
    for t in out_cur:       # the true running balance, in statement order
        run += t['amt']
        t['bal'] = run
    return out_cur, out_dep, opening_cur, opening_dep


# ----------------------------------------------------------------------------- output
def write_csv(path, header, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)


def dd(d):
    return d.strftime('%d/%m/%Y')


def main():
    run_milk()
    for y in range(Y0, Y1 + 1):
        yearly_expenses(y, HERD[y])
        pay_rent(y)
    # rent: pay_rent defined below
    run_livestock()
    run_cash_sales_evasion()
    run_contracting()
    run_payroll()
    run_other_paye_income()
    run_grants()
    run_capital()
    run_loans()
    run_personal()
    flush_statements()
    run_errors()
    run_vat_returns()
    cur, dep, o_cur, o_dep = simulate_cash()

    # ---- omitted statement pages (omission) and duplicates / overlaps (noise)
    gaps = [(date(2008, 10, 4), date(2008, 10, 19)), (date(2012, 7, 12), date(2012, 7, 24)),
            (date(2017, 2, 1), date(2017, 2, 13)), (date(2022, 9, 5), date(2022, 9, 21))]
    dup_idx = set()
    ids_by_year = defaultdict(list)
    for t in cur:
        t['gap'] = any(a <= t['date'] <= b for a, b in gaps)
        ids_by_year[t['date'].year].append(t)
    for y in range(Y0, Y1 + 1):
        cand = [t for t in ids_by_year[y] if not t['gap'] and t['date'].month in (6, 11, 3, 5)]
        if y in (2009, 2014, 2019, 2023) and cand:
            for t in R.sample(cand, 2):
                t['dup'] = True
    issue('GAP', 'omission', 2008, 'Four statement pages missing (Oct 2008, Jul 2012, Feb 2017, Sep 2022): rows absent but the running balance continues',
          'Running-balance break between consecutive rows: report a statement gap; never invent the missing lines.')
    issue('DUPROW', 'error', 2009, 'Eight rows duplicated in the export (same date, text, amount and balance)', 'Distinguish an export duplicate from a real second payment.')
    issue('OVERLAP', 'error', 2010, 'The 2010, 2016 and 2021 files start 10 days early and repeat the prior December', 'Fingerprint dedup across overlapping files.')

    key_rows = []
    for y in range(Y0, Y1 + 1):
        fn = f'bank/aib_current_{y}.csv'
        rows = []
        extra = []
        if y in (2010, 2016, 2021):
            extra = [t for t in ids_by_year[y - 1] if t['date'] >= date(y - 1, 12, 22) and not t['gap']]
        seq = extra + [t for t in ids_by_year[y]]
        n = 1
        for t in seq:
            if t['gap']:
                key_rows.append([fn, '', dd(t['date']), eur(t['amt']), 'OMITTED_FROM_STATEMENT', t['cat'], t['biz'], ';'.join(t['docs']), t['flag'], t['note']])
                continue
            n += 1
            deb = eur(-t['amt']) if t['amt'] < 0 else ''
            cr = eur(t['amt']) if t['amt'] > 0 else ''
            rows.append([dd(t['date']), t['desc'], deb, cr, eur(t['bal']), t['ref']])
            if t in extra:
                key_rows.append([fn, n, dd(t['date']), eur(t['amt']), 'OVERLAP_COPY', t['cat'], t['biz'], ';'.join(t['docs']), 'OVERLAP', ''])
            else:
                key_rows.append([fn, n, dd(t['date']), eur(t['amt']), '', t['cat'], t['biz'], ';'.join(t['docs']), t['flag'], t['note']])
            if t.get('dup') and t not in extra:
                rows.append([dd(t['date']), t['desc'], deb, cr, eur(t['bal']), t['ref']])
                n += 1
                key_rows.append([fn, n, dd(t['date']), eur(t['amt']), 'EXPORT_DUPLICATE', t['cat'], t['biz'], '', 'DUP_ROW', 'duplicate of previous row'])
        write_csv(os.path.join(OUT, fn), ['Date', 'Description', 'Debit', 'Credit', 'Balance', 'Reference'], rows)
    # deposit account, one file
    rows = [[dd(date(Y0, 1, 1)), 'OPENING BALANCE', '', '', eur(o_dep), '']]
    for t in dep:
        rows.append([dd(t['date']), t['desc'], eur(-t['amt']) if t['amt'] < 0 else '', eur(t['amt']) if t['amt'] > 0 else '', eur(t['bal']), ''])
    write_csv(os.path.join(OUT, 'bank/aib_deposit_2006_2025.csv'), ['Date', 'Description', 'Debit', 'Credit', 'Balance', 'Reference'], rows)
    write_csv(os.path.join(OUT, 'answer_key_bank.csv'),
              ['file', 'row', 'date', 'amount', 'statement_defect', 'true_category', 'business_use (Y=farm, N=private, M=mixed, X=exempt, U=unexplained, T=own transfer)', 'doc_ids', 'issue_code', 'note'], key_rows)

    # ---- documents
    for d in DOCS:
        pass
    pur = [d for d in DOCS if d['direction'] == 'purchase']
    sal = [d for d in DOCS if d['direction'] == 'sales']
    hdr = ['invoiceNumber', 'date', 'party', 'description', 'net', 'vat', 'gross', 'due', 'currency', 'reference', 'type', 'supplyDate', 'partyVatNo', 'docId']

    def drow(d):
        return [d['number'], dd(d['date']), d['party'], d['desc'], eur(d['net']), eur(d['vat']), eur(d['gross']), dd(d['due']), d['ccy'], d['ref'],
                'credit_note' if d['typ'] == 'credit_note' else d['typ'], d['supply'], d['partyvat'], d['id']]
    write_csv(os.path.join(OUT, 'invoices_purchases.csv'), hdr, [drow(d) for d in sorted(pur, key=lambda x: (x['date'], x['id']))])
    write_csv(os.path.join(OUT, 'invoices_sales.csv'), hdr, [drow(d) for d in sorted(sal, key=lambda x: (x['date'], x['id']))])
    write_csv(os.path.join(OUT, 'answer_key_documents.csv'),
              ['docId', 'invoiceNumber', 'direction', 'true_category', 'business_use', 'vat_deductible', 'issue_code', 'note'],
              [[d['id'], d['number'], d['direction'], d['cat'], d['biz'], 'Y' if d['deductible'] else 'N', d['flag'], d['note']] for d in sorted(DOCS, key=lambda x: x['id'])])
    write_csv(os.path.join(OUT, 'other_documents.csv'), ['docId', 'kind', 'date', 'issuer', 'subject', 'gross', 'net', 'reference', 'note'],
              [[o['id'], o['kind'], dd(o['date']), o['issuer'], o['subject'], eur(o['gross']), eur(o['net']), o['ref'], o['note']] for o in sorted(OTHER, key=lambda x: (x['date'], x['id']))])
    write_csv(os.path.join(OUT, 'payslips.csv'), ['period', 'employee', 'pps', 'gross', 'paye', 'usc', 'prsi_employee', 'prsi_employer', 'net', 'paid'],
              [[p['period'], p['employee'], p['pps'], eur(p['gross']), eur(p['paye']), eur(p['usc']), eur(p['prsi_ee']), eur(p['prsi_er']), eur(p['net']), p['paid']] for p in sorted(PAYSLIPS, key=lambda x: (x['period'], x['employee']))])
    write_csv(os.path.join(OUT, 'cheque_stubs.csv'), ['chequeNo', 'date', 'payee', 'amount', 'memo'],
              [[x['no'], dd(x['date']), x['payee'], eur(x['amount']), x['memo']] for x in sorted(CHEQUES, key=lambda x: x['no'])])
    write_csv(os.path.join(OUT, 'herd_register_events.csv'), ['date', 'event', 'head', 'counterparty', 'reference', 'notes'],
              [[dd(r['date']), r['event'], r['head'], r['counterparty'], r['reference'], r['notes']] for r in sorted(REGISTER, key=lambda r: (r['date'], r['event']))])

    # ---- truth
    def tot(cat, rows=cur, sign=1):
        return sum(t['amt'] for t in rows if t['cat'] == cat) * sign
    srows = []
    for y in range(Y0, Y1 + 1):
        a = ANNUAL[y]
        yr = [t for t in cur if t['date'].year == y]
        srows.append([y, a['cows'], a['litres'], round(a['litres'] / a['cows']), eur(a['milk_net']), a['births'], a['bull_calves'], a['heifer_calves_sold'], a['culls'],
                      eur(sum(t['amt'] for t in yr if t['cat'] == 'livestock_sale')), eur(sum(t['amt'] for t in yr if t['cat'] == 'scheme_income')),
                      eur(sum(t['amt'] for t in yr if t['cat'] == 'capital_grant')), eur(sum(t['amt'] for t in yr if t['cat'] == 'contracting_income')),
                      eur(-sum(t['amt'] for t in yr if t['cat'] in ('wages_net', 'paye_prsi_usc'))), eur(a.get('loan_interest', 0)),
                      eur(-sum(t['amt'] for t in yr if t['cat'] == 'drawings')), eur(a.get('vat_t2_not_deductible', 0)), yr[-1]['bal'] / 100 if yr else ''])
    write_csv(os.path.join(OUT, 'answer_key_annual_summary.csv'),
              ['year', 'avg_cows', 'litres', 'litres_per_cow', 'milk_net_eur', 'calves_born', 'bull_calves', 'heifer_calves_sold', 'culls', 'livestock_sales_banked',
               'scheme_income', 'capital_grants', 'contracting_banked', 'payroll_cash_out', 'loan_interest_est', 'drawings', 'vat_t2_wrongly_claimed', 'year_end_current_balance'], srows)
    write_csv(os.path.join(OUT, 'answer_key_issues.csv'), ['code', 'kind', 'year', 'what_was_planted', 'expected_tool_behaviour'],
              [[i['code'], i['kind'], i['year'], i['what'], i['expected_tool_behaviour']] for i in ISSUES])
    print(f'current rows {len(cur)}, deposit rows {len(dep)}, purchase docs {len(pur)}, sales docs {len(sal)}, other {len(OTHER)}, issues {len(ISSUES)}')
    print('min balance', min(t['bal'] for t in cur) / 100, 'max', max(t['bal'] for t in cur) / 100, 'final', cur[-1]['bal'] / 100)


def pay_rent(y):
    amt = c(RENT_ACRES[y] * RENT_PER_ACRE[y])
    d = date(y, 11, 20)
    dc = add_doc('purchase', d, "T. Buckley (landlord, conacre)", f'Conacre rent {y}: {RENT_ACRES[y]} acres @ {RENT_PER_ACRE[y]}/acre', amt, 'none', 'land_rent', typ='rent_receipt',
                 vat=0, vatno_ok=False)
    t = add_bank('cur', d + timedelta(days=R.randint(0, 6)), 'CHQ %06d' % (_seq.__setitem__('chq', _seq['chq'] + 1) or _seq['chq']) if y < 2014 else 'SEPA CT T BUCKLEY', -amt, '', 'land_rent', 'Y', [dc])


if __name__ == '__main__':
    main()
