// The shape a `trend` field's value must have. The hub stores it as given;
// it draws nothing and keeps no history of its own.
import { z } from 'zod'
import { TREND_POINTS, type TrendValue } from '../shared/model.ts'

const iso = z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'is not a date and time')

export const trendSchema = z
  .object({
    points: z.array(z.object({ at: iso, value: z.number().finite() })).max(TREND_POINTS, `holds at most ${TREND_POINTS} points`),
    step: z.boolean().optional(),
    from: iso.optional(),
    to: iso.optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    labels: z.record(z.string(), z.string()).optional(),
    unit: z.string().max(8).optional(),
    link: z.string().url().optional(),
    link_title: z.string().max(60).optional(),
  })
  .strict() satisfies z.ZodType<TrendValue>
