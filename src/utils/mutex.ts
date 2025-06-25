export function getFixedArray<T>(length: number): T[] {
  const array = new Array<T>()

  array.push = function (...items: T[]): number {
    if (items.length >= length) {
      items.splice(0, items.length - length)
    }

    if (this.length >= length) {
      this.pop()
    }

    return Array.prototype.push.apply(this, items)
  }

  return array
}

export class IdMutex {
  private lockMap: Map<
    string,
    { queue: Array<() => void>; locked: boolean; current: number }
  > = new Map()

  constructor(private concurrently?: number) {}

  lock(id: string, limit?: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.lockMap.get(id)?.locked) {
        this.lockMap.get(id)?.queue.push(resolve)
      } else {
        if (!this.lockMap.get(id)) {
          this.lockMap.set(id, {
            queue: limit ? getFixedArray(limit) : [],
            locked: true,
            current: 0,
          })
        }
        const get = this.lockMap.get(id)
        if (get) {
          if (this.concurrently) {
            get.current += 1
          }
          get.locked = this.concurrently
            ? get.current >= this.concurrently
            : true
        }
        resolve()
      }
    })
  }

  release(id: string) {
    const get = this.lockMap.get(id)
    const resolve = get?.queue.shift()
    if (get && this.concurrently && !resolve) {
      get.current -= 1
      get.locked = get.current >= this.concurrently
    }
    if (resolve) {
      resolve()
    } else {
      if (
        !this.concurrently ||
        (this.concurrently && (get?.current ?? 0) <= 0)
      ) {
        this.lockMap.delete(id)
      }
    }
  }

  clear(id?: string) {
    if (id) {
      for (const k of this.lockMap.keys()) {
        if (k.includes(id)) {
          this.lockMap.delete(k)
        }
      }
    } else {
      this.lockMap = new Map()
    }
  }

  get(id: string) {
    return this.lockMap.get(id)?.queue?.length || 0
  }

  get allKeys() {
    return this.lockMap.keys()
  }
}

export function IdMute(
  mutex: IdMutex,
  getId: (...args: any[]) => string,
  limit?: number,
) {
  return (
    _target: unknown,
    _propertyKey: PropertyKey,
    descriptor: PropertyDescriptor,
  ) => {
    const fn = descriptor.value
    descriptor.value = function (...args: unknown[]) {
      const id = getId(...args)
      return mutex
        .lock(id, limit)
        .then(() => fn.apply(this, args))
        .then((res) => {
          mutex.release(id)
          return res
        })
        .catch((e) => {
          mutex.release(id)
          throw e
        })
    }
  }
}
