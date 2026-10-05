<?php
declare(strict_types=1);

use Vitral\Core\Numbering;

return [
    'renderPattern / counterPeriod match lib/numbering.ts' => function (): void {
        foreach (T::fixtures()['numbering'] as $r) {
            T::eq($r['r'], Numbering::renderPattern($r['p'], $r['seq'], $r['at'], 'Asia/Tehran'), "render {$r['p']} @ {$r['at']}");
            T::eq($r['period'], Numbering::counterPeriod($r['p'], $r['at'], 'Asia/Tehran'), "period {$r['p']} @ {$r['at']}");
        }
    },
];
