# Generate a simple Lasair icon using .NET System.Drawing
Add-Type -AssemblyName System.Drawing

$size = 1024
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

# Background - dark gradient circle
$bgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 15, 23, 42))
$g.FillRectangle($bgBrush, 0, 0, $size, $size)

# Accent circle
$accentBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 99, 102, 241))
$g.FillEllipse($accentBrush, 64, 64, 896, 896)

# Inner dark circle
$innerBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 15, 23, 42))
$g.FillEllipse($innerBrush, 128, 128, 768, 768)

# "L" letter
$font = New-Object System.Drawing.Font("Segoe UI", 420, [System.Drawing.FontStyle]::Bold)
$textBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 99, 102, 241))
$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = [System.Drawing.StringAlignment]::Center
$sf.LineAlignment = [System.Drawing.StringAlignment]::Center
$rect = New-Object System.Drawing.RectangleF(0, 0, $size, $size)
$g.DrawString("L", $font, $textBrush, $rect, $sf)

$g.Dispose()

$iconPath = Join-Path $PSScriptRoot "app-icon.png"
$bmp.Save($iconPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

Write-Host "Icon saved to $iconPath"
