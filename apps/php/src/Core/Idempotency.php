<?php
declare(strict_types=1);

namespace Vitral\Core;

/** Port of apps/server/src/lib/idempotency.ts (principle 4). */
final class Idempotency
{
    private const UUID_RE = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i';

    public static function requireKey(Request $req): string
    {
        $key = $req->header('idempotency-key');
        if (!is_string($key) || !preg_match(self::UUID_RE, $key)) {
            throw new AppError('validation', 'کلید یکتای درخواست (Idempotency-Key) لازم است', ['Idempotency-Key' => 'UUID لازم است']);
        }
        return strtolower($key);
    }

    /**
     * Run $work once per request id. The key row is inserted first inside the same transaction, so a concurrent
     * duplicate blocks on the unique index until this one commits and then replays its response. If $work throws,
     * the transaction (and the key) roll back and the client may retry with the same key.
     *
     * @param callable(Db):array{status:int,body:mixed} $work
     * @return array{status:int,body:mixed,replayed:bool}
     */
    public static function run(Db $db, string $requestId, ?string $userId, string $endpoint, callable $work): array
    {
        return $db->transaction(function (Db $trx) use ($requestId, $userId, $endpoint, $work) {
            $inserted = true;
            try {
                $trx->insertNoReturn('idempotency_keys', [
                    'request_id' => $requestId,
                    'user_id' => $userId,
                    'created_by' => $userId,
                    'endpoint' => $endpoint,
                    'response' => null,
                ]);
            } catch (\PDOException $e) {
                if (!Db::isDuplicateKey($e)) throw $e;
                $inserted = false;
            }
            if (!$inserted) {
                $existing = $trx->one('SELECT user_id, endpoint, response FROM idempotency_keys WHERE request_id = ? FOR UPDATE', [$requestId]);
                if (!$existing || $existing['user_id'] !== $userId || $existing['endpoint'] !== $endpoint || $existing['response'] === null) {
                    throw new AppError('conflict', 'این کلید یکتا قبلاً برای درخواست دیگری به کار رفته است');
                }
                $stored = Json::toArray($existing['response']);
                return ['status' => (int) $stored['status'], 'body' => $stored['body'] ?? null, 'replayed' => true];
            }
            $result = $work($trx);
            // stored exactly as the Node code stores JSON.stringify(result)
            $trx->exec('UPDATE idempotency_keys SET response = ? WHERE request_id = ?', [Json::encode(['status' => $result['status'], 'body' => $result['body']]), $requestId]);
            return ['status' => $result['status'], 'body' => Json::decode(Json::encode($result['body'])), 'replayed' => false];
        });
    }
}
