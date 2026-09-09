@echo off
title GetYes Desktop - MODE TEST
cd /d "%~dp0"
rem ============================================================
rem   TEST depuis l'app desktop (mode dev - correctifs du 08/09)
rem   - GETYES_EAR=mic : l'oreille capte TON MICRO (test solo,
rem     tu joues le prospect a voix haute).
rem   - DOSSIER_OFF=1 : fiche LOCALE Sarah/Nutriva 180e forcee
rem     (en base, des offres de test d'Eliott sont encore actives).
rem   L'app INSTALLEE (GetYes.exe) n'a pas encore ces correctifs :
rem   utiliser CE lanceur pour les tests, jusqu'a la prochaine release.
rem ============================================================
set GETYES_EAR=mic
set DOSSIER_OFF=1
echo   Demarrage de GetYes Desktop en mode TEST (micro + fiche locale)...
npm start
