# Can I trust the Leabhar installer?

You downloaded `Leabhar-Setup-x64.exe` and you are rightly suspicious of
unknown installers. This page gives you evidence, not just promises, that
Leabhar is safe to run and that it will not upload your private
accounting data anywhere.

If you are not technical, read the first two sections. If you have a
sceptical friend who is, the "How to verify this yourself" section is
written for them.

## What Leabhar does with your data

Your accounting database, your invoices and receipts, and your backups
all stay on your own machine. **Nothing is uploaded.** By default Leabhar
makes no network connection at all.

This is not a claim you have to take on faith — it is a property of how
the program is built, and you can check it. The source code is public.
The only place in the entire program that reaches out to the internet is
an optional AI feature that reads text out of invoices and receipts.
That feature is **off by default** and only switches on if you, the user,
explicitly provide an Anthropic API key. Until you do, no byte of your
data leaves the computer.

## Uninstalling is safe

Your accounting database, documents and backups live in a directory the
installer never touches, not even on uninstall. The installer keeps two
separate folders: your chosen install location (`%LOCALAPPDATA%\Leabhar`
by default) holds your data, and the app's own program files live one
level down, in an `app` subfolder inside it. Uninstalling removes only
that `app` subfolder — never the parent folder your data lives in — and
tells you exactly where your data still is when it finishes. This is
enforced by `src/lib/paths.ts` and `scripts/installer.nsi`, both public
source you can read yourself.

## How to verify this yourself

Three levels, from easiest to most thorough.

### Easy — pull the network cable

Disconnect your computer from the internet completely. Start Leabhar,
load the demo company, import a statement, open a document, run a report.
Everything works. There is no "connecting to server" spinner, no error
about being offline, because the application never needed the network.

### Medium — watch it with a firewall

With the network back on, run Leabhar normally (without setting an
`ANTHROPIC_API_KEY`) and watch outbound connections in Windows Firewall,
GlassWire, or Little Snitch. You will see the application make **no
outbound connections at all**. Now set `ANTHROPIC_API_KEY` and trigger
document extraction: the only connection that appears is to
`api.anthropic.com`. That is the entire network surface of the program.

### Full — read the source

Leabhar is open source. Clone it and search for every outbound network
call:

```sh
git clone https://github.com/aiscimi-code/Leabhar.git
cd Leabhar
grep -rn "fetch(" src/
```

There is exactly one result:

```
src/domain/extraction/anthropicProvider.ts:74:
  const response = await fetch('https://api.anthropic.com/v1/messages', {
```

That call sits behind a guard that requires an API key you have to
provide yourself (`src/domain/extraction/anthropicProvider.ts`). The PDF
reader even carries an explicit comment that it makes no network
fetches (`src/domain/extraction/pdfText.ts`). If a sceptical friend can
find a second `fetch()`, or any code that sends your data somewhere
without your API key, that is a bug worth reporting — see
[../SECURITY.md](../SECURITY.md).

## Is the installer a virus?

The installer is not built in secret. It is built in public by GitHub
Actions, from the exact same source code you can read above, every time a
release is tagged. You can see the build run that produced the file you
downloaded, and you can diff the commit it ran from against the source.

Each release is accompanied by:

- **A VirusTotal scan report.** VirusTotal runs the installer through
  70+ independent antivirus engines. The link to the public report is
  attached to the release and noted in the release notes.
- **An SBOM (Software Bill of Materials).** A `sbom.json` file listing
  every dependency the installer was built from, including transitive
  ones, so you can see exactly what is inside the package.
- **The exact commit the build ran from**, so you can review or diff
  the code yourself before you run it.

## How to scan the installer yourself

You do not have to trust our VirusTotal link. Scan the file yourself:

1. Go to [virustotal.com](https://www.virustotal.com) (free, no account
   needed).
2. Upload `Leabhar-Setup-x64.exe`.
3. Read the report. The 70+ engines each give a clean or detection
   verdict. A handful of detections on an unsigned NSIS installer is
   common and addressed below.

Or, more simply, right-click `Leabhar-Setup-x64.exe` in Windows and
choose **Scan** to let Windows Defender check it locally.

## Why there is still a SmartScreen warning

When you run the installer, Windows may show a blue "Windows protected
your PC" SmartScreen warning. This is **not** a detection of malware.

SmartScreen warns about any executable that is not digitally signed with
an EV code-signing certificate. Code signing costs real money and an
unsigned publisher builds reputation with SmartScreen slowly, over many
downloads. For a small open-source project at v1, that reputation does
not exist yet, so the warning appears. The warning is cosmetic — it says
"unrecognised publisher", not "this file is dangerous."

The real proof of safety is the evidence above: the public build
process, the VirusTotal report from 70+ engines, the SBOM, and the open
source you can read. If you have reviewed those and are comfortable,
choose **More info → Run anyway** to proceed.

Code signing is a known gap for v1 and is tracked as a future
improvement once the project can justify the cost.

## Known VirusTotal detections on v0.1.0

The v0.1.0 release's VirusTotal report shows **1 detection out of 57
engines**: the Sigma rule "Sysmon File Executable Creation Detected"
by frack113. This is a heuristic rule that flags any NSIS installer
that creates temporary executable files during its normal installation
process — which every NSIS installer does. It is not a detection of
malware, a virus, or any specific malicious behaviour. It is the same
class of false positive that affects Electron, Wireshark, Audacity,
and every other application that ships an unsigned NSIS installer.

The other 56 engines — including Microsoft Defender, Kaspersky, ESET,
Bitdefender, Sophos, and CrowdStrike — all report the file as clean.

If you see this detection on a future release, check the ratio: 1-2
detections from heuristic/Sigma rules on an unsigned NSIS installer are
expected and documented here. A sudden cluster of detections from
named engines would be a different matter and would be investigated.

## What the app does NOT do

For the avoidance of doubt, Leabhar:

- Sends **no telemetry** and **no analytics**. There is no usage
  tracking, no crash reporting home, no "phone home" of any kind.
- Makes **no background network calls**. It does not check for updates,
  download anything, or contact any server on startup.
- Requires **no account**. You do not register, log in, or create a
  cloud identity to use it.
- Has **no cloud sync**. There is no Leabhar server that holds a copy
  of your data. Your database is a single file on your disk; your
  documents are files in a folder.

If any of these statements were ever to change, this page would change
to match — and because it lives in the same public repository as the
code, you would be able to see the change in the commit history.
