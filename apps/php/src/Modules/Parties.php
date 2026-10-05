<?php
declare(strict_types=1);

namespace Vitral\Modules;

use Vitral\Core\App;
use Vitral\Core\AppError;
use Vitral\Core\Audit;
use Vitral\Core\AuthUser;
use Vitral\Core\Crud;
use Vitral\Core\Db;
use Vitral\Core\Query;
use Vitral\Core\Request;
use Vitral\Core\Router;
use Vitral\Core\Schema;
use Vitral\Core\V;
use Vitral\Lib\Decimal;
use Vitral\Lib\Num;
use Vitral\Rules\Money;

/** Port of apps/server/src/modules/parties (routes.ts + locations.ts). */
final class Parties
{
    public const PARTY_ROLES = ['customer', 'factory', 'painter', 'anodizer', 'ingot_supplier', 'scrap_trader', 'smelter', 'die_maker', 'carrier', 'tool_supplier', 'other'];
    public const LOCATION_KINDS = ['own_warehouse', 'factory', 'painter', 'in_transit', 'customer', 'border'];
    private const LOCATION_KIND = ['factory' => 'factory', 'painter' => 'painter', 'anodizer' => 'painter', 'smelter' => 'factory'];

    /** @return array<string,Schema> the party fields; without defaults for PATCH (zod `.default().optional()` keeps undefined) */
    private static function base(bool $create): array
    {
        $o = static fn (Schema $s) => $create ? $s : $s->optional();
        $phones = V::array(V::string()->trim()->min(3)->max(30))->max(10);
        $roles = V::array(V::enum(self::PARTY_ROLES));
        $cur = V::enum(Num::CURRENCIES);
        return [
            'name' => $o(V::text(200)->min(1, 'نام لازم است')),
            'name_ar' => V::optText(200),
            'name_en' => V::optText(200),
            'phones' => $create ? $phones->default([]) : $phones->optional(),
            'country' => V::optText(80),
            'city' => V::optText(80),
            'address' => V::optText(500),
            'national_id' => V::optText(40),
            'roles' => $create ? $roles->default([]) : $roles->optional(),
            'default_currency' => $create ? $cur->default('TOMAN') : $cur->optional(),
            'note' => V::optText(2000),
        ];
    }

    public static function presentParty(array $r): array
    {
        return [
            'id' => $r['id'], 'name' => $r['name'], 'name_ar' => $r['name_ar'], 'name_en' => $r['name_en'], 'phones' => $r['phones'], 'country' => $r['country'], 'city' => $r['city'], 'address' => $r['address'],
            'national_id' => $r['national_id'], 'roles' => $r['roles'], 'default_currency' => $r['default_currency'], 'note' => $r['note'], 'active' => $r['active'], 'merged_into_id' => $r['merged_into_id'],
            'created_at' => $r['created_at'], 'updated_at' => $r['updated_at'], 'version' => $r['version'],
        ];
    }

    /** Every factory / painter gets its own location automatically (7.2). */
    private static function ensureLocations(Db $trx, array $party, string $userId): void
    {
        $kinds = [];
        foreach ((array) $party['roles'] as $role) {
            $k = self::LOCATION_KIND[$role] ?? null;
            if ($k !== null && !in_array($k, $kinds, true)) $kinds[] = $k;
        }
        foreach ($kinds as $kind) {
            $exists = $trx->value('SELECT id FROM locations WHERE party_id = ? AND kind = ? LIMIT 1', [$party['id'], $kind]);
            if ($exists === null) $trx->insertNoReturn('locations', ['name' => $party['name'], 'kind' => $kind, 'party_id' => $party['id'], 'created_by' => $userId]);
        }
    }

    public static function register(Router $r, App $app): void
    {
        self::registerLocations($r, $app);

        Crud::routes($r, $app, [
            'table' => 'parties',
            'path' => '/parties',
            'createSchema' => V::object(self::base(true)),
            'updateSchema' => V::object(V::versionField() + self::base(false) + ['active' => V::boolean()->optional()]),
            'listSchema' => V::object(['q' => V::string()->max(100)->optional(), 'role' => V::enum(self::PARTY_ROLES)->optional(), 'active' => V::enum(['true', 'false'])->optional()]),
            'present' => static fn (array $row) => self::presentParty($row),
            'filter' => static function (Query $qb, array $q) {
                if (($q['q'] ?? '') !== '') {
                    $like = Db::like((string) $q['q']);
                    $qb->where("parties.name LIKE ? OR JSON_SEARCH(parties.phones, 'one', ?) IS NOT NULL", [$like, $like]);
                }
                if (!empty($q['role'])) $qb->where('JSON_CONTAINS(parties.roles, ?)', [json_encode((string) $q['role'])]);
                if (!empty($q['active'])) $qb->where('parties.active = ?', [$q['active'] === 'true']);
                else $qb->where('parties.merged_into_id IS NULL');
            },
            'orderBy' => 'name',
            'afterCreate' => static fn (Db $trx, array $row, array $input, AuthUser $user) => self::ensureLocations($trx, $row, $user->id),
            'afterUpdate' => static fn (Db $trx, array $before, array $after, AuthUser $user) => self::ensureLocations($trx, $after, $user->id),
        ]);

        /** Similar parties by name or phone, suggested before creating (7.2). */
        $r->get('/parties/similar', static function (Request $req) use ($app) {
            $req->requireUser();
            $q = V::object(['name' => V::string()->max(200)->optional(), 'phone' => V::string()->max(30)->optional()])->parse($req->query);
            $name = $q['name'] ?? '';
            $phone = $q['phone'] ?? '';
            if ($name === '' && $phone === '') return ['items' => []];
            // Node tries pg_trgm similarity and falls back to this LIKE / exact-phone query (the extension is not installed).
            $qb = Query::from('parties')->where('merged_into_id IS NULL')->limit(10);
            if ($name !== '') $qb->where('name LIKE ?', [Db::like($name)]);
            if ($phone !== '') $qb->where('JSON_CONTAINS(phones, ?)', [json_encode($phone, JSON_UNESCAPED_UNICODE)]);
            return ['items' => array_map([self::class, 'presentParty'], $qb->all($app->db()))];
        });

        /** Merge duplicate parties (manager only): the loser is deactivated and points at the winner; references are re-pointed. */
        $r->post('/parties/:id/merge', static function (Request $req) use ($app) {
            $me = $req->requirePermission('settings.manage');
            ['id' => $id] = V::idParam()->parse($req->params);
            ['into_id' => $intoId] = V::object(['into_id' => V::uuid()])->parse($req->body());
            if ($id === $intoId) throw new AppError('validation', 'طرف نمی‌تواند با خودش ادغام شود');
            return $app->db()->transaction(static function (Db $trx) use ($id, $intoId, $me) {
                $loser = $trx->find('parties', $id, true);
                $winner = $trx->find('parties', $intoId, true);
                if (!$loser || !$winner) throw new AppError('not_found');
                foreach ([
                    ['orders', 'party_id'], ['contracts', 'party_id'], ['documents', 'party_id'], ['locations', 'party_id'], ['production_runs', 'factory_party_id'],
                    ['coating_runs', 'party_id'], ['transfers', 'carrier_party_id'], ['transfers', 'bill_to_party_id'], ['dies', 'owner_party_id'], ['dies', 'maker_party_id'],
                    ['free_notes', 'party_id'], ['tasks', 'party_id'], ['bundles', 'factory_party_id'], ['material_lots', 'owner_party_id'], ['die_orders', 'customer_party_id'], ['die_orders', 'maker_party_id'],
                ] as [$table, $col]) {
                    $trx->exec('UPDATE ' . Db::ident($table) . ' SET ' . Db::ident($col) . ' = ? WHERE ' . Db::ident($col) . ' = ?', [$intoId, $id]);
                }
                $phones = array_values(array_unique([...(array) $winner['phones'], ...(array) $loser['phones']]));
                $roles = array_values(array_unique([...(array) $winner['roles'], ...(array) $loser['roles']]));
                $trx->update('parties', ['phones' => $phones, 'roles' => $roles] + Db::bump(), 'id = ?', [$intoId]);
                $trx->update('parties', ['active' => false, 'merged_into_id' => $intoId] + Db::bump(), 'id = ?', [$id]);
                Audit::log($trx, ['userId' => $me->id, 'entity' => 'parties', 'entityId' => $id, 'action' => 'merge', 'before' => self::presentParty($loser), 'after' => ['merged_into_id' => $intoId]]);
                return ['ok' => true];
            });
        });

        /** Party file: balances per currency (finance.view), open orders, documents. Weight account lives under /stock. */
        $r->get('/parties/:id/summary', static function (Request $req) use ($app) {
            $me = $req->requireUser();
            ['id' => $id] = V::idParam()->parse($req->params);
            $db = $app->db();
            $party = $db->find('parties', $id);
            if (!$party) throw new AppError('not_found');
            $orders = $db->all('SELECT id, number, title, status_sales, currency, due_date, archived, created_at FROM orders WHERE party_id = ? ORDER BY created_at DESC LIMIT 100', [$id]);
            $out = ['party' => self::presentParty($party), 'orders' => $orders];
            if ($req->can('finance.view')) $out['balances'] = self::balancesFor($db, $id);
            return $out;
        });
    }

    /** R12 balances of a party per currency, from its posted documents. */
    public static function balancesFor(Db $db, string $partyId): mixed
    {
        $docs = $db->all("SELECT kind, amount, currency, status, barter_sign FROM documents WHERE party_id = ? AND status = 'posted'", [$partyId]);
        $balance = Money::partyBalance(array_map(static function (array $d) {
            $signed = in_array($d['kind'], ['barter', 'fx_difference', 'opening_balance'], true);
            return [
                'kind' => $d['kind'],
                // Node: String(Number(amount ?? 0) * (barter_sign ?? 1))
                'amount' => $signed ? Decimal::of($d['amount'] ?? '0')->mul($d['barter_sign'] ?? 1)->toFixed() : ($d['amount'] ?? '0'),
                'currency' => $d['currency'],
                'status' => $d['status'],
            ];
        }, $docs));
        return $balance === [] ? new \stdClass() : $balance;
    }

    // ---------------------------------------------------------------- locations.ts

    private static function registerLocations(Router $r, App $app): void
    {
        Crud::routes($r, $app, [
            'table' => 'locations',
            'path' => '/locations',
            'createSchema' => V::object([
                'name' => V::text(200)->min(1),
                'kind' => V::enum(self::LOCATION_KINDS)->refine(static fn ($k) => $k !== 'in_transit', 'محل «در مسیر» یکتا و خودکار است'),
                'party_id' => V::uuid()->nullable()->optional(),
            ]),
            'updateSchema' => V::object(V::versionField() + [
                'name' => V::text(200)->min(1)->optional(),
                'active' => V::boolean()->optional(),
                'party_id' => V::uuid()->nullable()->optional(),
                'note' => V::optText(),
            ]),
            'writePermission' => 'settings.manage',
            'listSchema' => V::object(['q' => V::string()->max(100)->optional(), 'kind' => V::enum(self::LOCATION_KINDS)->optional(), 'party_id' => V::uuid()->optional(), 'active' => V::enum(['true', 'false'])->optional()]),
            'present' => static fn (array $r) => ['id' => $r['id'], 'name' => $r['name'], 'kind' => $r['kind'], 'party_id' => $r['party_id'], 'active' => $r['active'], 'version' => $r['version']],
            'filter' => static function (Query $qb, array $q) {
                if (($q['q'] ?? '') !== '') $qb->where('locations.name LIKE ?', [Db::like((string) $q['q'])]);
                if (!empty($q['active'])) $qb->where('locations.active = ?', [$q['active'] === 'true']);
                if (!empty($q['kind'])) $qb->where('locations.kind = ?', [(string) $q['kind']]);
                if (!empty($q['party_id'])) $qb->where('locations.party_id = ?', [(string) $q['party_id']]);
            },
            'orderBy' => 'name',
        ]);
    }
}
