# =============================================================================
# FullPage Capture & Copy — アイコン生成スクリプト
# -----------------------------------------------------------------------------
#   使い方:  pwsh -File tools\make-icons.ps1            … icons/ を再生成
#            pwsh -File tools\make-icons.ps1 -Preview   … 生成後に拡大確認用の
#                                                          PNG を一時フォルダに出力
#
#   デザイン: オレンジ地 + Webマーク（地球儀） + カメラ
#   サイズごとに構成を変えている（16px に2つの物体を詰めると必ず潰れるため）:
#     16px      … グローブのみ（中央・大きめ）
#                 ※経線は「地球儀」の識別に必須。省くと禁止マークに見える
#     32px 以上 … グローブ + 右下にカメラ
#     48px 以上 … 緯線（上下）とレンズの内側リングを追加
#
#   色を変えたい場合は $BackgroundColor を編集して再実行するだけ。
# =============================================================================

param([switch]$Preview)

Add-Type -AssemblyName System.Drawing

$BackgroundColor = [System.Drawing.Color]::FromArgb(255, 26, 115, 232)  # blue
# 参考: オレンジにする場合は FromArgb(255, 234, 88, 12)
$dir = Join-Path (Split-Path $PSScriptRoot -Parent) 'icons'
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }

function New-RoundedPath([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

foreach ($s in 16, 32, 48, 128) {
  $withCamera = $s -ge 32

  $bmp = New-Object System.Drawing.Bitmap($s, $s)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  $bgC = $BackgroundColor
  $bg = New-Object System.Drawing.SolidBrush($bgC)
  $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)

  $g.FillPath($bg, (New-RoundedPath 0 0 ([single]$s) ([single]$s) ([single][Math]::Max(2, $s * 0.22))))

  # --- Web マーク（地球儀） ---
  if ($withCamera) {
    $cx = [single]($s * 0.40); $cy = [single]($s * 0.40); $r = [single]($s * 0.29)
  } else {
    $cx = [single]($s * 0.50); $cy = [single]($s * 0.50); $r = [single]($s * 0.36)
  }
  $lw = [single][Math]::Max(1.0, $s * 0.045)

  $g.FillEllipse($white, [single]($cx - $r), [single]($cy - $r), [single]($r * 2), [single]($r * 2))
  $g.FillRectangle($bg, [single]($cx - $r), [single]($cy - $lw / 2), [single]($r * 2), $lw)

  if ($s -ge 48) {
    $off = $r * 0.52
    $half = [single]($r * 0.86)
    $g.FillRectangle($bg, [single]($cx - $half), [single]($cy - $off - $lw / 2), [single]($half * 2), $lw)
    $g.FillRectangle($bg, [single]($cx - $half), [single]($cy + $off - $lw / 2), [single]($half * 2), $lw)
  }

  $pen = New-Object System.Drawing.Pen($bgC, $lw)
  $g.DrawEllipse($pen, [single]($cx - $r * 0.47), [single]($cy - $r), [single]($r * 0.94), [single]($r * 2))
  $pen.Dispose()

  # --- カメラ ---
  if ($withCamera) {
    # タイルの角丸に縁取りが欠けないよう、右下に余白を残す
    $bx = [single]($s * 0.44); $by = [single]($s * 0.52)
    $bw = [single]($s * 0.44); $bh = [single]($s * 0.32)
    $pad = [single]($s * 0.05)
    $g.FillPath($bg, (New-RoundedPath ([single]($bx - $pad)) ([single]($by - $pad)) ([single]($bw + $pad * 2)) ([single]($bh + $pad * 2)) ([single]($s * 0.11))))
    $g.FillPath($white, (New-RoundedPath $bx $by $bw $bh ([single]($s * 0.075))))

    $lens = [single]($bw * 0.44)
    $lx = [single]($bx + ($bw - $lens) / 2)
    $ly = [single]($by + ($bh - $lens) / 2)
    $g.FillEllipse($bg, $lx, $ly, $lens, $lens)
    if ($s -ge 48) {
      $inner = [single]($lens * 0.40)
      $g.FillEllipse($white, [single]($lx + ($lens - $inner) / 2), [single]($ly + ($lens - $inner) / 2), $inner, $inner)
    }
  }

  $g.Dispose()
  $bmp.Save((Join-Path $dir "icon$s.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output "icons/icon$s.png"
}

if (-not $Preview) { return }

# --- 拡大確認用のシート（ツールバーを模した明暗の背景に等倍 + 拡大） ---
$zoom = 9
$sizes = 16, 32, 48, 128
$totalW = 40
foreach ($sz in $sizes) { $totalW += [Math]::Min($sz, 48) * $zoom + 24 }
$prev = New-Object System.Drawing.Bitmap($totalW, [int](48 * $zoom + 90))
$pg = [System.Drawing.Graphics]::FromImage($prev)
$pg.Clear([System.Drawing.Color]::White)
$font = New-Object System.Drawing.Font('Arial', 11, [System.Drawing.FontStyle]::Bold)
$black = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 30, 30, 30))
$lightBar = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 241, 243, 244))
$darkBar = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 41, 42, 45))

$x = 16
foreach ($sz in $sizes) {
  $img = [System.Drawing.Image]::FromFile((Join-Path $dir "icon$sz.png"))
  $pg.DrawString("${sz}px", $font, $black, [single]$x, 4)
  $box = [Math]::Max(26, $sz + 10)
  $pg.FillRectangle($lightBar, [single]$x, 24, $box, $box)
  $pg.FillRectangle($darkBar, [single]($x + $box + 6), 24, $box, $box)
  $pg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $pg.DrawImage($img, [int]($x + ($box - $sz) / 2), [int](24 + ($box - $sz) / 2), $sz, $sz)
  $pg.DrawImage($img, [int]($x + $box + 6 + ($box - $sz) / 2), [int](24 + ($box - $sz) / 2), $sz, $sz)
  $draw = [Math]::Min($sz, 48)
  $pg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
  $pg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
  $pg.DrawImage($img, [int]$x, [int](24 + $box + 14), [int]($draw * $zoom), [int]($draw * $zoom))
  $img.Dispose()
  $x += $draw * $zoom + 24
}
$pg.Dispose()
$out = Join-Path ([System.IO.Path]::GetTempPath()) 'fpcc-icon-preview.png'
$prev.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output $out
