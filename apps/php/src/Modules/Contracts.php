<?php
declare(strict_types=1);

namespace Vitral\Modules;

use Vitral\Core\App;
use Vitral\Core\Crud;
use Vitral\Core\Db;
use Vitral\Core\Query;
use Vitral\Core\Router;
use Vitral\Core\Schema;
use Vitral\Core\V;
use Vitral\Lib\Num;

/** Port of apps/server/src/modules/contracts/routes.ts. */
final class Contracts
{
    public const SERVICES = ['extrusion', 'paint', 'anodize', 'smelting', 'die_making', 'transport'];

    /** @return array<string,Schema> */
    private static function base(bool $create): array
    {
        $o = static fn (Schema $s) => $create ? $s : $s->optional();
        return [
            'party_id' => $o(V::uuid()),
            'service' => $o(V::enum(self::SERVICES)),
            'rate_per_kg' => V::decimalString()->nullable()->optional(),
            'currency' => $create ? V::enum(Num::CURRENCIES)->default('TOMAN') : V::enum(Num::CURRENCIES)->optional(),
            'weight_basis' => V::enum(['input', 'good_output'])->nullable()->optional(),
            'fixed_fee' => V::decimalString()->nullable()->optional(),
            'scrap_owner' => V::enum(['vitral', 'factory'])->nullable()->optional(),
            'scrap_credit_rate' => V::decimalString()->nullable()->optional(),
            'includes_material' => V::boolean()->nullable()->optional(),
            'freight_payer' => V::enum(['vitral', 'party'])->nullable()->optional(),
            'rework_payer' => V::enum(['vitral', 'party'])->nullable()->optional(),
            'allowed_loss_percent' => V::decimalString()->nullable()->optional(),
            'valid_from' => $o(V::dateOnly()),
            'valid_to' => V::dateOnly()->nullable()->optional(),
            'note' => V::optText(2000),
        ];
    }

    /** Contracts carry rates: the global guard strips rate_per_kg/fixed_fee for users without finance.view. */
    public static function presentContract(array $c): array
    {
        return [
            'id' => $c['id'], 'party_id' => $c['party_id'], 'service' => $c['service'], 'rate_per_kg' => $c['rate_per_kg'], 'currency' => $c['currency'], 'weight_basis' => $c['weight_basis'], 'fixed_fee' => $c['fixed_fee'],
            'scrap_owner' => $c['scrap_owner'], 'scrap_credit_rate' => $c['scrap_credit_rate'], 'includes_material' => $c['includes_material'], 'freight_payer' => $c['freight_payer'], 'rework_payer' => $c['rework_payer'],
            'allowed_loss_percent' => $c['allowed_loss_percent'], 'valid_from' => $c['valid_from'], 'valid_to' => $c['valid_to'], 'note' => $c['note'], 'version' => $c['version'], 'created_at' => $c['created_at'],
        ];
    }

    /**
     * The contract in force for a party and service on a date (latest valid_from wins); the day is the UTC date of $at
     * (Node: at.toISOString().slice(0, 10)). Returns the contracts row or null.
     */
    public static function activeContract(Db $db, string $partyId, string $service, \DateTimeInterface|string|null $at = null): ?array
    {
        $d = $at === null ? new \DateTimeImmutable('now') : ($at instanceof \DateTimeInterface ? $at : new \DateTimeImmutable($at));
        $day = \DateTimeImmutable::createFromInterface($d)->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d');
        return $db->one(
            'SELECT * FROM contracts WHERE party_id = ? AND service = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?) ORDER BY valid_from DESC LIMIT 1',
            [$partyId, $service, $day, $day],
        );
    }

    public static function register(Router $r, App $app): void
    {
        Crud::routes($r, $app, [
            'table' => 'contracts',
            'path' => '/contracts',
            'createSchema' => V::object(self::base(true)),
            'updateSchema' => V::object(V::versionField() + self::base(false)),
            'writePermission' => 'settings.manage',
            'readPermission' => 'settings.manage',
            'listSchema' => V::object(['party_id' => V::uuid()->optional(), 'service' => V::enum(self::SERVICES)->optional()]),
            'present' => static fn (array $row) => self::presentContract($row),
            'filter' => static function (Query $qb, array $q) {
                if (!empty($q['party_id'])) $qb->where('contracts.party_id = ?', [(string) $q['party_id']]);
                if (!empty($q['service'])) $qb->where('contracts.service = ?', [(string) $q['service']]);
            },
            'orderBy' => 'valid_from',
        ]);
    }
}
