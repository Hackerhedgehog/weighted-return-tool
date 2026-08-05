export interface BucketRow {
  uid: string
  bucketId: number
  label: string
  payout: number
  weight: number
  optionalId: string
}

export type SortKey =
  | 'bucketId'
  | 'label'
  | 'payout'
  | 'weight'
  | 'weightedReturn'
  | 'chance'

export interface SortState {
  key: SortKey
  dir: 1 | -1
}

let uidCounter = 0
export function nextUid(): string {
  uidCounter += 1
  return `b${uidCounter}`
}
