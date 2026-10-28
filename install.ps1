param([string]$PythonExe, [switch]$SkipDependencies)
$ErrorActionPreference = 'Stop'
$pluginRoot = $PSScriptRoot
$venvPython = Join-Path $pluginRoot '.venv\Scripts\python.exe'
if (!(Test-Path -LiteralPath $venvPython)) {
    if (!$PythonExe) { throw 'Укажите -PythonExe с полным путём к Python 3.10–3.12.' }
    & $PythonExe -m venv (Join-Path $pluginRoot '.venv')
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось создать окружение Python.' }
}
if (!$SkipDependencies) {
    & $venvPython -m pip install -r (Join-Path $pluginRoot 'requirements.txt')
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось установить библиотеки.' }
}
$ffmpegPath = (Get-Command ffmpeg -ErrorAction Stop).Source
$ffprobePath = (Get-Command ffprobe -ErrorAction Stop).Source
$destination = Join-Path $env:APPDATA 'Adobe\CEP\extensions\StreamVoiceMarker'
New-Item -ItemType Directory -Force -Path $destination | Out-Null
Copy-Item -Path (Join-Path $pluginRoot 'cep\*') -Destination $destination -Recurse -Force
$runtime = @{
    python = $venvPython
    worker = Join-Path $pluginRoot 'backend\analyze.py'
    data = Join-Path $pluginRoot 'data'
    profiles = Join-Path $pluginRoot 'profiles'
    default_profile = 'streamer-main.json'
    ffmpeg = $ffmpegPath
    ffprobe = $ffprobePath
}
$runtime | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $destination 'runtime.json') -Encoding UTF8
# Adobe CEP 12 requires this flag to load an unsigned local development panel.
$registryPath = 'HKCU:\Software\Adobe\CSXS.12'
New-Item -Path $registryPath -Force | Out-Null
New-ItemProperty -Path $registryPath -Name PlayerDebugMode -Value '1' -PropertyType String -Force | Out-Null
Write-Host 'Установлено. Premiere: Окно > Расширения > Stream Voice Marker. Если панели нет, перезапустите Premiere.'
