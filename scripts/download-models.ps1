param(
    [switch]$Force,
    [switch]$IncludeMedium
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$modelsDir = Join-Path $root "models"
New-Item -ItemType Directory -Force -Path $modelsDir | Out-Null

$models = [ordered]@{
    "ggml-base-q5_1.bin"  = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin"
    "ggml-small-q5_1.bin" = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin"
}
if ($IncludeMedium) {
    $models["ggml-medium-q5_0.bin"] = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium-q5_0.bin"
}

foreach ($name in $models.Keys) {
    $target = Join-Path $modelsDir $name
    if ((Test-Path $target) -and -not $Force) {
        $sizeMb = [math]::Round((Get-Item $target).Length / 1MB, 1)
        Write-Host "Ja existe: $name ($sizeMb MB)"
        continue
    }
    Write-Host "Baixando $name ..."
    & curl.exe -L --fail --retry 3 -o $target $models[$name]
    if ($LASTEXITCODE -ne 0) {
        throw "Falha ao baixar $name"
    }
    Write-Host "OK: $name"
}

# Brazilian Portuguese narration voice (tiny-voca, Apache-2.0)
$ttsDir = Join-Path $modelsDir "tiny-voca"
New-Item -ItemType Directory -Force -Path $ttsDir | Out-Null
$ttsFiles = [ordered]@{
    "tiny-voca-ptbr.onnx" = "https://huggingface.co/Haple/tiny-voca-ptbr-kokoro/resolve/main/model/tiny-voca-ptbr.onnx"
    "tiny-voca-ptbr.json" = "https://huggingface.co/Haple/tiny-voca-ptbr-kokoro/raw/main/model/tiny-voca-ptbr.json"
}
foreach ($name in $ttsFiles.Keys) {
    $target = Join-Path $ttsDir $name
    if ((Test-Path $target) -and -not $Force) {
        Write-Host "Ja existe: tiny-voca/$name"
        continue
    }
    Write-Host "Baixando voz pt-BR $name ..."
    & curl.exe -L --fail --retry 3 -o $target $ttsFiles[$name]
    if ($LASTEXITCODE -ne 0) {
        throw "Falha ao baixar a voz $name"
    }
    Write-Host "OK: $name"
}

Write-Host ""
Write-Host "Modelos prontos em $modelsDir"
Write-Host "Inicie com start.bat"
