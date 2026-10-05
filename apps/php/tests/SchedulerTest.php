<?php
declare(strict_types=1);

use Vitral\Core\App;
use Vitral\Core\Config;
use Vitral\Lib\Scheduler;

/**
 * The lazy cron / cron.php timing rules of src/Lib/Scheduler.php (apps/server/src/scheduler.ts semantics without a
 * daemon). No database: only the day/threshold arithmetic and the LAZY_CRON switch.
 */
function schedApp(array $extra = []): App
{
    return new App(Config::fromArray(array_merge([
        'APP_ENV' => 'test', 'DB_NAME' => 'vitral_php_test', 'SESSION_SECRET' => str_repeat('s', 40),
        'LOG_DIR' => sys_get_temp_dir() . '/vitral-sched-test', 'DAILY_REPORT_TIME' => '21:00',
    ], $extra), dirname(__DIR__)));
}

/** Unix time of a Tehran wall-clock moment (fixed +03:30, like lib/dates.ts). */
function tehranAt(int $y, int $m, int $d, int $hour, int $minute): int
{
    return gmmktime($hour, $minute, 0, $m, $d, $y) - 12600;
}

return [
    'the daily report is due from DAILY_REPORT_TIME Tehran until midnight' => function (): void {
        $app = schedApp();
        // 2026-10-05 is 1405/07/13; the Jalali day turns at Tehran midnight.
        T::eq(false, Scheduler::dayInfo($app, tehranAt(2026, 10, 5, 20, 59))['due'], '20:59 Tehran');
        T::eq(true, Scheduler::dayInfo($app, tehranAt(2026, 10, 5, 21, 0))['due'], '21:00 Tehran');
        T::eq(true, Scheduler::dayInfo($app, tehranAt(2026, 10, 5, 23, 59))['due'], '23:59 Tehran');
        T::eq(false, Scheduler::dayInfo($app, tehranAt(2026, 10, 6, 0, 10))['due'], 'after midnight it is a new day');
        T::eq('1405/07/13', Scheduler::dayInfo($app, tehranAt(2026, 10, 5, 23, 59))['key']);
        T::eq('1405/07/14', Scheduler::dayInfo($app, tehranAt(2026, 10, 6, 0, 10))['key'], 'a Tehran day, not a UTC day');
        T::eq('2026-10-05', Scheduler::dayInfo($app, tehranAt(2026, 10, 5, 23, 59))['dateKey'], 'the daily_reports key');
    },
    'another report time moves the threshold' => function (): void {
        $six = schedApp(['DAILY_REPORT_TIME' => '06:30']);
        T::eq(false, Scheduler::dayInfo($six, tehranAt(2026, 10, 5, 6, 29))['due']);
        T::eq(true, Scheduler::dayInfo($six, tehranAt(2026, 10, 5, 6, 30))['due']);
        // the threshold is that Tehran moment as a UTC instant
        T::eq(tehranAt(2026, 10, 5, 6, 30), Scheduler::dayInfo($six, tehranAt(2026, 10, 5, 12, 0))['threshold']);
        // a nonsense value falls back to 21:00 instead of never firing
        $bad = schedApp(['DAILY_REPORT_TIME' => 'نیمه‌شب']);
        T::eq(true, Scheduler::dayInfo($bad, tehranAt(2026, 10, 5, 21, 1))['due']);
        T::eq(false, Scheduler::dayInfo($bad, tehranAt(2026, 10, 5, 20, 1))['due']);
    },
    'LAZY_CRON: auto is off under the built-in server and the CLI, always is on, false is off' => function (): void {
        // The unit tests run under the CLI, where 'auto' must not start background work.
        T::eq(false, Scheduler::lazyEnabled(schedApp()));
        T::eq(false, Scheduler::lazyEnabled(schedApp(['LAZY_CRON' => true])));
        T::eq(true, Scheduler::lazyEnabled(schedApp(['LAZY_CRON' => 'always'])));
        foreach (['0', 'false', 'off', 'no', false] as $off) T::eq(false, Scheduler::lazyEnabled(schedApp(['LAZY_CRON' => $off])), 'off: ' . var_export($off, true));
        // Not installed yet (no database in config.php): never run jobs.
        T::eq(false, Scheduler::lazyEnabled(new App(Config::fromArray(['LAZY_CRON' => 'always'], dirname(__DIR__)))));
    },
];
