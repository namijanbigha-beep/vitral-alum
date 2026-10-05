<?php
declare(strict_types=1);

namespace Vitral\Lib;

use Vitral\Core\Db;
use Vitral\Core\Json;
use Vitral\Rules\Production;

/**
 * Port of apps/server/src/modules/daily/report.ts: the daily report (spec §12-a text, decisions, production, transfers,
 * filler checks, money, free notes, tasks) and its nightly snapshot. Dates are Jalali arrays ['jy','jm','jd'].
 * Instants are ISO strings (Db returns them so); SQL parameters go through Db::dt().
 */
final class DailyReport
{
    private static function kg(string|Decimal $v): string
    {
        return Num::toPersianDigits((string) preg_replace('/\.?0+$/', '', Decimal::of($v)->toFixed(3)));
    }

    /**
     * Section 2 text in the exact shape of the staff's Telegram message (spec §12-a).
     * @param list<array{product_id:string,product_name:string,total_kg:string,bundles:list<array<string,mixed>>}> $groups
     */
    public static function productionText(array $groups, string $totalKg, int $bundleCount, bool $full = false): string
    {
        $lines = ['📋 گزارش موجودی تولید شده پروفیل خام', '🟥 کد بندیل » وزن بندیل 🟥'];
        foreach ($groups as $g) {
            $lines[] = "🔹 {$g['product_name']}: " . self::kg($g['total_kg']) . ' کیلو';
            foreach ($g['bundles'] as $b) {
                $line = Num::toPersianDigits((string) $b['code']) . ' ◂ ' . self::kg($b['weight_kg']);
                if ($full) {
                    $extra = [];
                    if ($b['bars']) $extra[] = Num::toPersianDigits((string) $b['bars']) . ' شاخه';
                    if ($b['g_per_m'] !== null && $b['g_per_m'] !== '') $extra[] = Num::toPersianDigits((string) $b['g_per_m']) . ' گرم/متر';
                    if ($b['mixed']) $extra[] = 'درهم';
                    if ($b['status'] !== 'ok') $extra[] = $b['status'] === 'damaged' ? 'خرابی' : ($b['status'] === 'wrong_product' ? 'اشتباه تولید' : 'نیازمند بررسی');
                    if ($b['note'] !== null && $b['note'] !== '') $extra[] = $b['note'];
                    if ($extra) $line .= ' (' . implode('، ', $extra) . ')';
                }
                $lines[] = $line;
            }
        }
        array_push($lines, '━━━━━━━━━━', '✅ جمع کل: ' . self::kg($totalKg) . ' کیلو', '📦 تعداد بندیل: ' . Num::toPersianDigits((string) $bundleCount));
        return implode("\n", $lines);
    }

    /**
     * Bundles reported in [start, end) (or of one run), grouped per product (R23: a mixed bundle counts once; its weight is split by lines).
     * @return array{groups:list<array<string,mixed>>,total_kg:string,bundle_count:int,text:string,text_full:string,bundles:list<array<string,mixed>>}
     */
    public static function productionSection(Db $db, ?string $start, ?string $end, ?string $runId = null): array
    {
        $sql = 'SELECT bundles.*, parties.name AS factory_name, production_runs.number AS run_number FROM bundles
                  LEFT JOIN parties ON parties.id = bundles.factory_party_id
                  LEFT JOIN production_runs ON production_runs.id = bundles.production_run_id
                 WHERE bundles.draft = 0 AND bundles.source = ?';
        $params = ['production'];
        if ($runId !== null) {
            $sql .= ' AND bundles.production_run_id = ?';
            $params[] = $runId;
        } else {
            $sql .= ' AND bundles.reported_at >= ? AND bundles.reported_at < ?';
            array_push($params, Db::dt($start), Db::dt($end));
        }
        $bundles = $db->all($sql . ' ORDER BY bundles.reported_at', $params);
        $ids = array_column($bundles, 'id');
        $lines = $ids ? $db->all(
            'SELECT bundle_lines.*, products.name_fa AS product_name, products.code AS product_code FROM bundle_lines
               INNER JOIN products ON products.id = bundle_lines.product_id
              WHERE bundle_id IN (' . Db::placeholders($ids) . ') ORDER BY sort',
            $ids,
        ) : [];
        $byBundle = [];
        foreach ($lines as $l) $byBundle[$l['bundle_id']][] = $l;
        $rows = [];
        foreach ($bundles as $b) {
            $bl = $byBundle[$b['id']] ?? [];
            $single = count($bl) === 1;
            $outLines = [];
            foreach ($bl as $l) {
                $w = $single ? $b['weight_kg'] : $l['weight_kg'];
                $gpm = Production::bundleWeightPerMeter($w, $single ? $b['packaging_kg'] : null, $l['bars'], $l['length_m']);
                $outLines[] = ['product_id' => $l['product_id'], 'product_name' => $l['product_name'], 'weight_kg' => $w, 'bars' => $l['bars'], 'length_m' => $l['length_m'], 'g_per_m' => $gpm['g_per_m'] ?? null];
            }
            $rows[] = [
                'id' => $b['id'], 'code' => $b['code'], 'code_is_temp' => $b['code_is_temp'], 'weight_kg' => $b['weight_kg'], 'status' => $b['status'], 'mixed' => count($bl) > 1,
                'warnings' => $b['warnings'], 'factory_name' => $b['factory_name'], 'run_number' => $b['run_number'], 'note' => $b['note'],
                'lines' => $outLines,
            ];
        }
        $groups = [];
        $total = Decimal::zero();
        foreach ($rows as $r) {
            $total = $total->add($r['weight_kg']);
            foreach ($r['lines'] as $l) {
                if ($l['weight_kg'] === null) continue;
                $g = $groups[$l['product_id']] ?? ['product_id' => $l['product_id'], 'product_name' => $l['product_name'], 'total_kg' => '0', 'bundles' => []];
                $g['total_kg'] = Num::round(Decimal::of($g['total_kg'])->add($l['weight_kg']), 'weight');
                $g['bundles'][] = ['code' => $r['code'], 'weight_kg' => $l['weight_kg'], 'bars' => $l['bars'], 'g_per_m' => $l['g_per_m'], 'note' => $r['note'], 'mixed' => $r['mixed'], 'status' => $r['status']];
                $groups[$l['product_id']] = $g;
            }
        }
        $gl = array_values($groups);
        usort($gl, static fn ($a, $b) => Decimal::of($b['total_kg'])->cmp($a['total_kg']));
        $totalKg = Num::round($total, 'weight');
        $n = count($rows);
        return ['groups' => $gl, 'total_kg' => $totalKg, 'bundle_count' => $n, 'text' => self::productionText($gl, $totalKg, $n), 'text_full' => self::productionText($gl, $totalKg, $n, true), 'bundles' => $rows];
    }

    /**
     * @param array{jy:int,jm:int,jd:int} $date
     * @param array{finance:bool,userId?:?string} $opts
     * @return array<string,mixed>
     */
    public static function buildDailyReport(Db $db, array $date, array $opts): array
    {
        $finance = (bool) $opts['finance'];
        $userId = $opts['userId'] ?? null;
        ['start' => $start, 'end' => $end] = Jalali::dayRange($date);
        $s = Db::dt($start);
        $e = Db::dt($end);
        $production = self::productionSection($db, $start, $end);
        $quarantine = $db->all(
            "SELECT bundles.id, bundles.code, bundles.weight_kg, bundles.status, bundles.defect, bundles.qc_note, parties.name AS factory_name, bundles.reported_at
               FROM bundles LEFT JOIN parties ON parties.id = bundles.factory_party_id
              WHERE bundles.status IN ('damaged', 'wrong_product', 'pending_review') AND bundles.draft = 0
              ORDER BY bundles.reported_at DESC LIMIT 100",
        );
        $weightWarnings = [];
        foreach ($production['bundles'] as $b) {
            if (is_array($b['warnings']) && array_is_list($b['warnings']) && count($b['warnings']) > 0) {
                $weightWarnings[] = ['id' => $b['id'], 'code' => $b['code'], 'weight_kg' => $b['weight_kg'], 'warnings' => $b['warnings']];
            }
        }
        $incompleteTickets = $db->all(
            "SELECT scale_tickets.id, scale_tickets.stage, transfers.number AS transfer_number, scale_tickets.created_at
               FROM scale_tickets LEFT JOIN transfers ON transfers.id = scale_tickets.transfer_id
              WHERE scale_tickets.status = 'needs_completion' ORDER BY scale_tickets.created_at DESC LIMIT 50",
        );
        $incompleteDocs = $finance ? $db->all("SELECT id, number, kind, status, description, created_at FROM documents WHERE status = 'needs_completion' ORDER BY created_at DESC LIMIT 50") : [];
        $pendingMoney = $finance ? (int) $db->value("SELECT COUNT(*) FROM documents WHERE status = 'reported'") : 0;

        $transfers = $db->all(
            'SELECT transfers.id, transfers.number, transfers.kind, transfers.status, transfers.departed_at, transfers.received_at, transfers.plate, transfers.driver_name, f.name AS from_name, t.name AS to_name,
                    (SELECT SUM(kg) FROM transfer_lines l WHERE l.transfer_id = transfers.id) AS kg,
                    (SELECT SUM(received_kg) FROM transfer_lines l WHERE l.transfer_id = transfers.id) AS received_kg,
                    (SELECT COUNT(*) FROM scale_tickets s WHERE s.transfer_id = transfers.id) AS tickets
               FROM transfers LEFT JOIN locations f ON f.id = transfers.from_location_id LEFT JOIN locations t ON t.id = transfers.to_location_id
              WHERE (transfers.departed_at >= ? AND transfers.departed_at < ?) OR (transfers.received_at >= ? AND transfers.received_at < ?)
              ORDER BY transfers.departed_at IS NULL, transfers.departed_at',
            [$s, $e, $s, $e],
        );
        foreach ($transfers as &$t) {
            $t['kg'] ??= '0';
            $t['received_kg'] ??= '0';
            $t['tickets'] = (int) $t['tickets'];
        }
        unset($t);

        $fillerChecks = $db->all(
            "SELECT die_events.id, dies.code AS die_code, die_events.kind, die_events.measured_filler_mm, die_events.detail, die_events.at
               FROM die_events INNER JOIN dies ON dies.id = die_events.die_id
              WHERE die_events.kind IN ('filler_check', 'repair', 'damage') AND die_events.at >= ? AND die_events.at < ?",
            [$s, $e],
        );

        $money = null;
        if ($finance || $userId) {
            $sql = "SELECT documents.id, documents.number, documents.kind, documents.status, documents.amount, documents.currency, documents.method, parties.name AS party_name, users.short_name AS reported_by_name, documents.created_at
                      FROM documents LEFT JOIN parties ON parties.id = documents.party_id LEFT JOIN users ON users.id = documents.reported_by
                     WHERE documents.kind IN ('receipt', 'payment') AND documents.created_at >= ? AND documents.created_at < ?";
            $params = [$s, $e];
            if (!$finance) {
                $sql .= ' AND documents.reported_by = ?';
                $params[] = $userId;
            }
            $money = $db->all($sql, $params);
        }

        $sql = 'SELECT free_notes.id, free_notes.`text`, free_notes.topic, free_notes.status, free_notes.`sensitive`, free_notes.kg, free_notes.qty, users.short_name AS user_name, free_notes.created_at'
            . ($finance ? ', free_notes.amount, free_notes.currency' : '')
            . ' FROM free_notes LEFT JOIN users ON users.id = free_notes.created_by WHERE free_notes.created_at >= ? AND free_notes.created_at < ?';
        $params = [$s, $e];
        if (!$finance) {
            if ($userId) {
                $sql .= ' AND (free_notes.`sensitive` = 0 OR free_notes.created_by = ?)';
                $params[] = $userId;
            } else {
                $sql .= ' AND free_notes.`sensitive` = 0';
            }
        }
        $freeNotes = $db->all($sql . ' ORDER BY free_notes.created_at', $params);

        $closed = $db->all(
            "SELECT tasks.id, tasks.title, tasks.done_at, tasks.done_note, users.short_name AS assignee FROM tasks LEFT JOIN users ON users.id = tasks.assignee_user_id
              WHERE tasks.status = 'done' AND tasks.done_at >= ? AND tasks.done_at < ?",
            [$s, $e],
        );
        $open = $db->all(
            "SELECT tasks.id, tasks.title, tasks.due_at, users.short_name AS assignee FROM tasks LEFT JOIN users ON users.id = tasks.assignee_user_id
              WHERE tasks.status = 'open' ORDER BY tasks.due_at IS NULL, tasks.due_at LIMIT 100",
        );

        $incomplete = [];
        foreach ($incompleteTickets as $t) $incomplete[] = $t + ['type' => 'scale_ticket'];
        foreach ($incompleteDocs as $d) $incomplete[] = $d + ['type' => 'document'];

        return [
            'date' => Jalali::format($date),
            'generated_at' => Json::iso(new \DateTimeImmutable('now')),
            'decisions' => ['quarantine' => $quarantine, 'weight_warnings' => $weightWarnings, 'incomplete_documents' => $incomplete, 'pending_money' => $pendingMoney],
            'production' => $production,
            'transfers' => $transfers,
            'filler_checks' => $fillerChecks,
            'money' => $money,
            'free_notes' => $freeNotes,
            'tasks' => ['closed' => $closed, 'open' => $open],
        ];
    }

    /** Gregorian date-only key (UTC midnight) of a Jalali date: lib/dates.ts jalaliToDateKey, as "Y-m-d". */
    public static function dateKey(array $date): string
    {
        $g = Jalali::toGregorian($date['jy'], $date['jm'], $date['jd']);
        return sprintf('%04d-%02d-%02d', $g['gy'], $g['gm'], $g['gd']);
    }

    /** Nightly snapshot (21:00 Tehran); idempotent per date. Stored with the finance view. */
    public static function snapshotDailyReport(Db $db, array $date, ?string $userId = null): void
    {
        $report = Json::encode(self::buildDailyReport($db, $date, ['finance' => true]));
        $db->exec(
            'INSERT INTO daily_reports (id, `date`, snapshot, created_by) VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE snapshot = VALUES(snapshot), generated_at = NOW(3)',
            [Db::uuid(), self::dateKey($date), $report, $userId],
        );
    }
}
