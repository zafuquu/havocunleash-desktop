# HAVOC OCR bridge (v11 A) — persistent WinRT OCR worker for the desktop.
# Protocol: one absolute PNG path per stdin line -> one JSON object per
# stdout line. The worker deletes each frame after reading it. WinRT OCR is
# fully offline (OS language pack); no npm/WASM/CDN anywhere.
#
#   startup : {"hello":true}  |  {"hello":false,"error":"..."}
#   frame   : {"ok":true,"imgW":W,"imgH":H,"at":ms,"words":[{t,x,y,w,h}]}
#             {"ok":false,"error":"..."}
$ErrorActionPreference = 'Stop'

[void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
[void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTask = @([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and
  $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function AwaitWinRt($op, $resultType) {
  $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($op))
  $task.Wait() | Out-Null
  return $task.Result
}

function Clean($obj) {
  if ($null -ne $obj) { try { $obj.Dispose() } catch { } }
}

$engine = $null
try { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() } catch { $engine = $null }
if ($null -eq $engine) {
  [Console]::Out.WriteLine('{"hello":false,"error":"no-ocr-language-pack"}')
  [Console]::Out.Flush()
  exit 2
}
[Console]::Out.WriteLine('{"hello":true}')
[Console]::Out.Flush()

while ($null -ne ($line = [Console]::In.ReadLine())) {
  $framePath = $line.Trim()
  $stream = $null
  $bitmap = $null
  try {
    if (-not [System.IO.File]::Exists($framePath)) { throw 'frame file missing' }
    $sf = AwaitWinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync($framePath)) ([Windows.Storage.StorageFile])
    $stream = AwaitWinRt ($sf.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = AwaitWinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = AwaitWinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $recognition = AwaitWinRt ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

    $words = New-Object System.Collections.Generic.List[object]
    foreach ($w in $recognition.Words) {
      $words.Add([pscustomobject]@{
        t = [string]$w.Text
        x = [double]$w.Bounds.X
        y = [double]$w.Bounds.Y
        w = [double]$w.Bounds.Width
        h = [double]$w.Bounds.Height
      })
    }
    $out = [pscustomobject]@{
      ok   = $true
      imgW = [int]$decoder.PixelWidth
      imgH = [int]$decoder.PixelHeight
      at   = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      words = $words
    }
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $out -Compress -Depth 5))
  } catch {
    $msg = ([string]$_.Exception.Message) -replace '"', "'"
    [Console]::Out.WriteLine(('{"ok":false,"error":"' + $msg + '"}'))
  } finally {
    Clean $bitmap
    Clean $stream
    try { if ([System.IO.File]::Exists($framePath)) { [System.IO.File]::Delete($framePath) } } catch { }
    [Console]::Out.Flush()
  }
}
