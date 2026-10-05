<?php
declare(strict_types=1);

namespace Vitral\Core;

/**
 * A request body that was exactly `[]`. PHP decodes both `[]` and an empty map to array(), so without this marker an
 * object schema could not tell «received array» from «empty object». Only Request::body() produces it, only at the top
 * level; Schema turns it back into [] (or reports «Expected object, received array», as zod does).
 */
final class JsonList
{
}
