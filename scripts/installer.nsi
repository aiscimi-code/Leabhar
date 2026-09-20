; Leabhar NSIS Installer
; -----------------------
; Produces Leabhar-Setup-x64.exe — a single installer that extracts a
; self-contained folder to %LOCALAPPDATA%\Leabhar\app and creates shortcuts.
;
; Install location vs. data location (issue #59): $INSTDIR (the directory
; picked on the "Choose Install Location" page, defaulting to
; %LOCALAPPDATA%\Leabhar) is the user's DATA root — where the database,
; documents and backups live (src/lib/paths.ts) — not where the app
; binaries themselves land. The binaries always go into a fixed "app"
; subfolder underneath it ($INSTDIR\app), appended by this script
; regardless of what $INSTDIR the user picks, so the uninstaller can
; always remove exactly that subfolder and nothing else, however the
; install was configured. Before this split, the binaries and the user's
; data lived in the exact same directory, so uninstalling deleted the
; user's accounting database, documents and backups with no warning and
; no way back.
;
; Build:  makensis scripts/installer.nsi
; Prereq:  dist/leabhar/app/ must exist (run `npm run build:package` first).

Unicode true
ManifestDPIAware true

!define APPNAME "Leabhar"
!define VERSION "0.2.5"
!define PUBLISHER "Intleacht Research Limited"
!define INSTALLDIR "$LOCALAPPDATA\Leabhar"

Name "${APPNAME} ${VERSION}"
OutFile "..\Leabhar-Setup-x64.exe"
InstallDir "${INSTALLDIR}"
RequestExecutionLevel user
ShowInstDetails show

Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Section "Install"
  ; Clear the previous install's app files (but not the user's database or
  ; documents, which live directly in $INSTDIR — a directory this section
  ; never touches outside of $INSTDIR\app). This prevents stale migration
  ; files from a previous version surviving an upgrade and breaking the
  ; new build.
  RMDir /r "$INSTDIR\app\.next"
  RMDir /r "$INSTDIR\app\drizzle"
  RMDir /r "$INSTDIR\app\node_modules"
  Delete "$INSTDIR\app\server.js"
  Delete "$INSTDIR\app\launcher.cjs"
  Delete "$INSTDIR\app\leabhar.bat"
  Delete "$INSTDIR\app\package.json"
  Delete "$INSTDIR\app\package-lock.json"

  SetOutPath "$INSTDIR\app"
  File /r "..\dist\leabhar\app\*.*"

  ; Shortcuts
  CreateDirectory "$SMPROGRAMS\Leabhar"
  CreateShortcut "$SMPROGRAMS\Leabhar\Leabhar.lnk" "$INSTDIR\app\leabhar.bat" "" "$INSTDIR\app\leabhar.bat" 0
  CreateShortcut "$DESKTOP\Leabhar.lnk" "$INSTDIR\app\leabhar.bat" "" "$INSTDIR\app\leabhar.bat" 0

  ; Uninstaller — lives inside app\ so it is removed along with the rest of
  ; the binaries on uninstall (NSIS supports an uninstaller deleting its own
  ; containing folder; this is a standard, well-supported idiom).
  WriteUninstaller "$INSTDIR\app\uninstall.exe"

  ; Add/Remove Programs entry
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Leabhar" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Leabhar" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Leabhar" "Publisher" "${PUBLISHER}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Leabhar" "InstallLocation" "$INSTDIR\app"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Leabhar" "UninstallString" "$INSTDIR\app\uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Leabhar" "DisplayIcon" "$INSTDIR\app\leabhar.bat"
SectionEnd

Section "Uninstall"
  ; Removes only the app binaries this installer owns ($INSTDIR\app) — never
  ; $INSTDIR itself, where the user's database, documents and backups live
  ; (src/lib/paths.ts). This is the fix for issue #59: uninstalling Leabhar
  ; must never delete the user's accounting data.
  RMDir /r "$SMPROGRAMS\Leabhar"
  Delete "$DESKTOP\Leabhar.lnk"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Leabhar"
  RMDir /r "$INSTDIR\app"

  MessageBox MB_OK "Leabhar has been uninstalled.$\r$\n$\r$\nYour accounting database, documents and backups have NOT been touched and remain at:$\r$\n$INSTDIR"
SectionEnd
