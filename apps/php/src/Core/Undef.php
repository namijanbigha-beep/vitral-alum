<?php
declare(strict_types=1);

namespace Vitral\Core;

/** JavaScript `undefined` for validation: a missing key or an absent request body (V::undef()). */
enum Undef
{
    case Value;
}
