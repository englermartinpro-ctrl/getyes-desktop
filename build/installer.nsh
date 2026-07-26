; Hook NSIS custom — à la DÉSINSTALLATION, tuer tout process runtime encore
; vivant. L'oreille (Python) ne doit JAMAIS survivre à la désinstallation de
; l'app (bug corrigé : elle continuait d'écouter après un uninstall).
; NB : les $$_ sont des $_ échappés (NSIS interprète $ comme SES variables) —
; PowerShell reçoit bien $_.Name / $_.CommandLine / $_.ProcessId.
!macro customUnInstall
  nsExec::Exec `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $$_.Name -eq 'python.exe' -and ($$_.CommandLine -match 'closepilot_ui_server|_ecoute_on|_test_micro_on|closepilot_live') } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
!macroend
