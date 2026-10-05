<?php
declare(strict_types=1);

namespace Vitral\Lib;

use Vitral\Core\Config;
use Vitral\Core\Log;

/**
 * Port of apps/server/src/modules/pdf/render.ts: the embedded Vazirmatn font, HTML escaping, the shared print CSS and
 * (only where the host allows it) headless Chromium → vector PDF / PNG.
 *
 * Shared cPanel hosting has no Chromium and usually forbids proc_open: chromiumAvailable() is then false and the PDF
 * routes hand the browser the same HTML with a print script instead («Save as PDF»), exactly like the Node fallback.
 */
final class PdfRender
{
    private static ?string $fontCss = null;
    private static ?bool $chromium = null;

    /** Vazirmatn embedded as a data URI so the PDF / print page carries the font (spec §14). */
    public static function loadFontCss(Config $config): string
    {
        if (self::$fontCss !== null) return self::$fontCss;
        $root = $config->str('ROOT');
        $candidates = array_filter([
            $config->get('VAZIRMATN_PATH') ? (string) $config->get('VAZIRMATN_PATH') : null,
            $config->get('WEB_DIST_DIR') ? rtrim((string) $config->get('WEB_DIST_DIR'), '/') . '/fonts/Vazirmatn-Variable.woff2' : null,
            defined('VITRAL_WEB_DIR') ? VITRAL_WEB_DIR . '/fonts/Vazirmatn-Variable.woff2' : null,
            $root . '/fonts/Vazirmatn-Variable.woff2',                       // the zip: web app files sit at the app root
            $root . '/../web/public/fonts/Vazirmatn-Variable.woff2',         // the repository
            $root . '/../web/dist/fonts/Vazirmatn-Variable.woff2',
        ]);
        foreach ($candidates as $c) {
            if (!is_file($c) || !is_readable($c)) continue;
            $buf = @file_get_contents($c);
            if ($buf === false || $buf === '') continue;
            return self::$fontCss = "@font-face{font-family:'Vazirmatn';src:url(data:font/woff2;base64," . base64_encode($buf) . ") format('woff2');font-weight:100 900;font-display:block;}";
        }
        return self::$fontCss = '';
    }

    /** esc() of render.ts: & < > " (not the apostrophe). */
    public static function esc(mixed $s): string
    {
        $v = $s === null ? '' : (is_bool($s) ? ($s ? 'true' : 'false') : (string) $s);
        return str_replace(['&', '<', '>', '"'], ['&amp;', '&lt;', '&gt;', '&quot;'], $v);
    }

    /** @param array{watermark?:?string,footer?:string,pageSize?:string} $opts */
    public static function baseCss(string $dir, string $fontCss, array $opts = []): string
    {
        $pageSize = $opts['pageSize'] ?? 'A4';
        $footer = self::esc($opts['footer'] ?? '');
        $pageWord = $dir === 'rtl' ? 'صفحه' : 'Page';
        $align = $dir === 'rtl' ? 'left' : 'right';
        $wm = !empty($opts['watermark']) ? '' : '.wm{display:none}';
        return "{$fontCss}
  @page { size: {$pageSize}; margin: 14mm 12mm 18mm 12mm; @bottom-center { content: \"{$footer} — {$pageWord} \" counter(page) \" / \" counter(pages); font-family: 'Vazirmatn', sans-serif; font-size: 9px; color: #555; } }
  * { box-sizing: border-box; }
  html { direction: {$dir}; }
  body { font-family: 'Vazirmatn', 'Noto Sans Arabic', sans-serif; font-size: 11px; color: #111; margin: 0; line-height: 1.6; }
  h1 { font-size: 18px; margin: 0; } h2 { font-size: 13px; margin: 12px 0 4px; }
  table { width: 100%; border-collapse: collapse; } thead { display: table-header-group; } tfoot { display: table-footer-group; } tr { page-break-inside: avoid; }
  th, td { border: 1px solid #999; padding: 4px 6px; vertical-align: top; } th { background: #eee; font-weight: 600; }
  .num { font-variant-numeric: tabular-nums; white-space: nowrap; text-align: {$align}; }
  .head { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #333; padding-bottom: 6px; margin-bottom: 8px; }
  .box { border: 1px solid #999; padding: 6px 8px; margin: 4px 0; } .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .muted { color: #666; font-size: 10px; } .img { width: 42px; height: 42px; object-fit: contain; }
  .sig { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 28px; } .sig div { border-top: 1px dashed #999; padding-top: 4px; text-align: center; height: 50px; }
  .cont { display: none; } .words { word-break: break-word; white-space: normal; }
  .wm { position: fixed; top: 40%; left: 10%; right: 10%; text-align: center; font-size: 48px; color: rgba(200,0,0,0.12); transform: rotate(-20deg); pointer-events: none; z-index: 0; }
  {$wm}";
    }

    /** True when CHROMIUM_PATH names an executable and the host lets PHP start processes (proc_open). Decided once. */
    public static function chromiumAvailable(Config $config): bool
    {
        if (self::$chromium !== null) return self::$chromium;
        $path = (string) ($config->get('CHROMIUM_PATH') ?? '');
        return self::$chromium = $path !== '' && self::procOpenAllowed() && @is_file($path) && @is_executable($path);
    }

    public static function procOpenAllowed(): bool
    {
        if (!function_exists('proc_open')) return false;
        $disabled = array_map('trim', explode(',', strtolower((string) ini_get('disable_functions'))));
        return !in_array('proc_open', $disabled, true);
    }

    /** For tests: forget the cached font / Chromium decision. */
    public static function reset(): void
    {
        self::$fontCss = null;
        self::$chromium = null;
    }

    /**
     * Chromium headless → vector PDF (selectable text, embedded font); PNG at print quality from the same HTML when asked.
     * @return array{pdf:string,png:?string}
     */
    public static function renderPdf(Config $config, string $html, bool $png = false): array
    {
        $dir = rtrim(sys_get_temp_dir(), '/') . '/vitral-pdf-' . bin2hex(random_bytes(8));
        if (!@mkdir($dir, 0700, true)) throw new \RuntimeException('cannot create a temporary directory for the PDF');
        try {
            $htmlPath = $dir . '/' . bin2hex(random_bytes(16)) . '.html';
            $pdfPath = $dir . '/out.pdf';
            file_put_contents($htmlPath, $html);
            $bin = (string) $config->get('CHROMIUM_PATH');
            $common = ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars', '--run-all-compositor-stages-before-draw', '--virtual-time-budget=3000', '--no-pdf-header-footer', '--user-data-dir=' . $dir . '/profile'];
            self::run([$bin, ...$common, '--print-to-pdf=' . $pdfPath, 'file://' . $htmlPath], 60);
            $pdf = @file_get_contents($pdfPath);
            if ($pdf === false || $pdf === '') throw new \RuntimeException('chromium produced no PDF');
            $pngBuf = null;
            if ($png) {
                $pngPath = $dir . '/out.png';
                self::run([$bin, ...$common, '--window-size=1240,1754', '--force-device-scale-factor=2', '--screenshot=' . $pngPath, 'file://' . $htmlPath], 60);
                $pngBuf = @file_get_contents($pngPath);
                if ($pngBuf === false || $pngBuf === '') throw new \RuntimeException('chromium produced no PNG');
            }
            return ['pdf' => $pdf, 'png' => $pngBuf];
        } finally {
            self::rmrf($dir);
        }
    }

    /** @param list<string> $argv */
    private static function run(array $argv, int $timeoutSeconds): void
    {
        $proc = proc_open($argv, [0 => ['file', '/dev/null', 'r'], 1 => ['file', '/dev/null', 'w'], 2 => ['pipe', 'w']], $pipes);
        if (!is_resource($proc)) throw new \RuntimeException('cannot start chromium');
        stream_set_blocking($pipes[2], false);
        $err = '';
        $deadline = microtime(true) + $timeoutSeconds;
        while (true) {
            $chunk = fread($pipes[2], 8192);
            if (is_string($chunk) && strlen($err) < 4000) $err .= $chunk;
            $st = proc_get_status($proc);
            if (!$st['running']) {
                $code = $st['exitcode'];
                break;
            }
            if (microtime(true) > $deadline) {
                proc_terminate($proc, 9);
                fclose($pipes[2]);
                proc_close($proc);
                throw new \RuntimeException('chromium timed out');
            }
            usleep(20000);
        }
        fclose($pipes[2]);
        proc_close($proc);
        if ($code !== 0) {
            Log::warn('chromium exited with an error', ['code' => $code, 'stderr' => mb_substr($err, 0, 500)]);
            throw new \RuntimeException("chromium exited with code {$code}");
        }
    }

    private static function rmrf(string $path): void
    {
        if (is_link($path) || is_file($path)) {
            @unlink($path);
            return;
        }
        if (!is_dir($path)) return;
        foreach (scandir($path) ?: [] as $e) {
            if ($e === '.' || $e === '..') continue;
            self::rmrf($path . '/' . $e);
        }
        @rmdir($path);
    }
}
