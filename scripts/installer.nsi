; Leabhar NSIS Installer
; -----------------------
; Produces Leabhar-Setup-x64.exe — a single installer that extracts a
; self-contained folder to %LOCALAPPDATA%\Leabhar and creates shortcuts.
;
; Build:  makensis scripts/installer.nsi
; Prereq:  dist/leabhar/ must exist (run `npm run build:package` first).

Unicode true
ManifestDPIAware true

!define APPNAME "Leabhar"
!define VERSION "0.2.2"
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
  SetOutPath "$INSTDIR"
  File /r "..\dist\leabhar\*.*"

  ; Shortcuts
  CreateDirectory "$SMPROGRAMS\Leabhar"
  CreateShortcut "$SMPROGRAMS\Leabhar\Leabhar.lnk" "$INSTDIR\leabhar.bat" "" "$INSTDIR\leabhar.bat" 0
  CreateShortcut "$DESKTOP\Leabhar.lnk" "$INSTDIR\leabhar.bat" "" "$INSTDIR\leabhar.bat" 0

  ; Uninstaller
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Add/Remove Programs entry
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Leabhar" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Leabhar" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Leabhar" "Publisher" "${PUBLISHER}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Leabhar" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Leabhar" "UninstallString" "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Leabhar" "DisplayIcon" "$INSTDIR\leabhar.bat"
SectionEnd

Section "Uninstall"
  RMDir /r "$SMPROGRAMS\Leabhar"
  Delete "$DESKTOP\Leabhar.lnk"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Leabhar"
  RMDir /r "$INSTDIR"
SectionEnd
