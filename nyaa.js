export default new class Nyaa {
    base = 'https://nyaasi-api.vercel.app/api/search'

    async single(query) {
        const {titles, episode, absoluteEpisodeNumber, exclusions = [], resolution, fetch} = query
        if (!titles?.length) return []

        return this.search({
            titles,
            episode,
            absoluteEpisode: absoluteEpisodeNumber,
            exclusions,
            resolution,
            batch: false,
            fetch
        })
    }

    async batch(query) {
        const {titles, exclusions = [], resolution, fetch} = query
        if (!titles?.length) return []

        return this.search({
            titles,
            exclusions,
            resolution,
            batch: true,
            fetch
        })
    }

    async movie(query) {
        const {titles, resolution, exclusions = [], fetch} = query
        if (!titles?.length) return []

        return this.search({
            titles,
            exclusions,
            resolution,
            batch: false,
            fetch
        })
    }

    async search({titles, episode, absoluteEpisode, exclusions, resolution, batch, fetch}) {
        const request = fetch ?? globalThis.fetch
        if (typeof request !== 'function') {
            throw new Error('Hayase did not provide a usable fetch function.')
        }

        const usableTitles = titles
            .filter(title => typeof title === 'string' && title.trim())
        const latinTitles = usableTitles.filter(title => /[A-Za-z]/.test(title))
        const titlePool = latinTitles.length ? latinTitles : usableTitles
        const title = titlePool.reduce((shortest, current) => {
            const shortestSearchTitle = this.cleanSearchTitle(shortest)
            const currentSearchTitle = this.cleanSearchTitle(current)

            if (!shortestSearchTitle) return current
            if (!currentSearchTitle) return shortest

            return currentSearchTitle.length < shortestSearchTitle.length ? current : shortest
        })
        const searchTitle = this.cleanSearchTitle(title)

        if (!searchTitle) return []

        let searchQuery = searchTitle
        if (!batch && episode != null) {
            searchQuery += ' ' + String(episode).padStart(2, '0')
        }
        if (batch) searchQuery += ' Batch'
        if (resolution) {
            searchQuery += ' ' + String(resolution).replace(/p$/i, '') + 'p'
        }

        const extraTitles = titlePool
            .filter(extraTitle => extraTitle !== title)
            .slice(0, 2)
        const params = new URLSearchParams({
            q: searchQuery,
            title,
            category: '1_0',
            batch: String(batch)
        })

        if (episode != null) {
            params.set('episode', String(episode))
        }
        if (absoluteEpisode != null) {
            params.set('absoluteEpisode', String(absoluteEpisode))
        }
        if (resolution) {
            params.set('resolution', String(resolution).replace(/p$/i, ''))
        }
        if (exclusions.length) {
            params.set('exclusions', exclusions.join(','))
        }
        if (extraTitles.length) {
            params.set('titles', extraTitles.join('|||'))
        }

        const response = await request(this.base + '?' + params.toString())
        if (!response.ok) {
            throw new Error(`The Nyaa search API returned HTTP ${response.status}.`)
        }

        const payload = await response.json()
        const items = this.findItems(payload)

        if (!items) {
            throw new Error('The Nyaa search API returned an unsupported response format.')
        }

        const normalizedExclusions = exclusions
            .filter(exclusion => typeof exclusion === 'string' && exclusion.trim())
            .map(exclusion => exclusion.toLowerCase())

        return items
            .map(item => this.mapResult(item, titles, batch))
            .filter(Boolean)
            .filter(result => !normalizedExclusions.some(exclusion =>
                result.title.toLowerCase().includes(exclusion)
            ))
    }

    cleanSearchTitle(title) {
        return String(title ?? '')
            .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim()
    }

    findItems(payload, depth = 0) {
        if (Array.isArray(payload)) return payload
        if (!payload || typeof payload !== 'object' || depth > 2) return null

        for (const key of ['data', 'results', 'torrents', 'items']) {
            const items = this.findItems(payload[key], depth + 1)
            if (items) return items
        }

        return null
    }

    mapResult(item, titles, batch) {
        if (!item || typeof item !== 'object') return null

        const title = this.firstString(
            item.title,
            item.name,
            item.Name,
            item.torrent_name
        )
        const magnet = this.firstString(
            item.magnet,
            item.Magnet,
            item.magnet_uri,
            item.magnetUri,
            item.links?.magnet
        )
        const suppliedHash = this.firstString(
            item.hash,
            item.info_hash,
            item.infoHash
        )
        const torrentUrl = this.firstString(
            item.torrent,
            item.torrent_url,
            item.torrentUrl,
            item.downloadUrl,
            item.download_url
        )
        const genericLink = this.firstString(item.link)
        const hash = suppliedHash || this.extractHash(magnet) || this.extractHash(genericLink)
        const safeGenericLink = genericLink && (
            genericLink.startsWith('magnet:') ||
            genericLink.endsWith('.torrent') ||
            /^[A-Fa-f0-9]{40}$/.test(genericLink)
        ) ? genericLink : ''
        const link = magnet || torrentUrl || safeGenericLink || hash

        if (!title || !link) return null

        const result = {
            title,
            link,
            hash,
            seeders: this.toNumber(item.seeders, item.Seeders),
            leechers: this.toNumber(item.leechers, item.Leechers),
            downloads: this.toNumber(
                item.downloads,
                item.Downloads,
                item.downloadCount,
                item.torrent_downloaded_count
            ),
            size: this.parseSize(item.size ?? item.total_size ?? item.Size),
            date: this.parseDate(
                item.date ??
                item.DateUploaded ??
                item.timestamp ??
                item.createdAt
            ),
            accuracy: this.getAccuracy(title, titles)
        }

        if (batch) result.type = 'batch'

        return result
    }

    firstString(...values) {
        const value = values.find(candidate =>
            typeof candidate === 'string' && candidate.trim()
        )

        return value?.trim() ?? ''
    }

    extractHash(value) {
        if (typeof value !== 'string') return ''

        const match = value.match(
            /(?:xt=urn:btih:|^)([A-Fa-f0-9]{40}|[A-Z2-7]{32})(?:&|$)/i
        )

        return match?.[1] ?? ''
    }

    toNumber(...values) {
        for (const value of values) {
            if (typeof value === 'number' && Number.isFinite(value)) {
                return value
            }
            if (typeof value !== 'string') continue

            const parsed = Number(value.replace(/,/g, '').trim())
            if (Number.isFinite(parsed)) return parsed
        }

        return 0
    }

    parseSize(value) {
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value
        }
        if (typeof value !== 'string') return 0

        const normalized = value.replace(/,/g, '').trim()
        const numeric = Number(normalized)

        if (Number.isFinite(numeric)) return numeric

        const match = normalized.match(/^([\d.]+)\s*([KMGTPE]?i?B)$/i)
        if (!match) return 0

        const amount = Number(match[1])
        const unit = match[2].toUpperCase()
        const powers = {
            B: 0,
            KB: 1,
            KIB: 1,
            MB: 2,
            MIB: 2,
            GB: 3,
            GIB: 3,
            TB: 4,
            TIB: 4,
            PB: 5,
            PIB: 5,
            EB: 6,
            EIB: 6
        }
        const power = powers[unit]

        if (!Number.isFinite(amount) || power == null) return 0

        return Math.round(
            amount * Math.pow(unit.includes('I') ? 1024 : 1000, power)
        )
    }

    parseDate(value) {
        if (value instanceof Date && !Number.isNaN(value.getTime())) {
            return value
        }

        let date

        if (typeof value === 'number') {
            date = new Date(value < 1000000000000 ? value * 1000 : value)
        } else {
            date = new Date(value ?? 0)
        }

        return Number.isNaN(date.getTime()) ? new Date(0) : date
    }

    getAccuracy(resultTitle, titles) {
        const normalizedResult = this.cleanSearchTitle(resultTitle).toLowerCase()
        const exactTitleMatch = titles.some(title => {
            const normalizedTitle = this.cleanSearchTitle(title).toLowerCase()

            return normalizedTitle && normalizedResult.includes(normalizedTitle)
        })

        return exactTitleMatch ? 'medium' : 'low'
    }

    async test(options, providedFetch) {
        const request = providedFetch ?? globalThis.fetch
        if (typeof request !== 'function') {
            throw new Error('Hayase did not provide a usable fetch function.')
        }

        const params = new URLSearchParams({
            q: 'one piece',
            category: '1_0'
        })
        const response = await request(this.base + '?' + params.toString())

        if (!response.ok) {
            throw new Error(`The Nyaa search API returned HTTP ${response.status}.`)
        }

        const payload = await response.json()
        const items = this.findItems(payload)

        if (!items) {
            throw new Error('The Nyaa search API returned an unsupported response format.')
        }

        return true
    }
}()