; Patrins uninstall cleanup
; Runs after the main uninstall (deleteAppDataOnUninstall handles %APPDATA%\Patrins)

!macro customUnInstall
  ; Remove Trusted Sites zone entry for patrins.com
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Internet Settings\ZoneMap\Domains\patrins.com"

  ; Disconnect Patrins drive letters (P through T) — silent, ignore errors
  nsExec::ExecToLog 'cmd /c net use P: /delete /y 2>nul'
  nsExec::ExecToLog 'cmd /c net use Q: /delete /y 2>nul'
  nsExec::ExecToLog 'cmd /c net use R: /delete /y 2>nul'
  nsExec::ExecToLog 'cmd /c net use S: /delete /y 2>nul'
  nsExec::ExecToLog 'cmd /c net use T: /delete /y 2>nul'
!macroend
