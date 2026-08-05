export default new class Nyaa {
    base = 'https://nyaa.si'

    async single(query) {
        const {
            titles,
            episode,
            absoluteEpisodeNumber,
            exclusions = [],
            resolution,
            fetch
        } = query

        if (!titles?.length) return []

        if (typeof fetch !== 'function') {
            throw new Error('Hayase did not provide its CORS-enabled fetch function.')
        }

        const episodeTargets = this.getEpisodeTargets(
            episode,
            absoluteEpisodeNumber
        )

        if (!episodeTargets.length) return []

        const searchTitles = this.getSearchTitles(titles)
        const broadSearchTitles = this.getBroadSearchTitles(
            titles,
            searchTitles
        )
        const absoluteTarget = episodeTargets.find(target =>
            target.kind === 'absolute'
        )
        const localTarget = episodeTargets.find(target =>
            target.kind === 'local'
        )

        if (absoluteTarget) {
            const directAbsoluteResults = await this.fetchSingleTargetResults({
                searchTitles,
                target: absoluteTarget,
                resolution,
                fetch,
                exclusions
            })

            if (directAbsoluteResults.length) {
                return this.prepareSingleResults(
                    directAbsoluteResults,
                    titles,
                    resolution,
                    'high'
                )
            }

            if (broadSearchTitles.length) {
                const broadAbsoluteResults = await this.fetchSingleTargetResults({
                    searchTitles: broadSearchTitles,
                    target: absoluteTarget,
                    resolution,
                    fetch,
                    exclusions
                })

                if (broadAbsoluteResults.length) {
                    return this.prepareSingleResults(
                        broadAbsoluteResults,
                        [...titles, ...broadSearchTitles],
                        resolution,
                        'medium'
                    )
                }
            }

            if (localTarget) {
                const titleOnlyResults = await this.fetchQueries(
                    this.buildTitleOnlyQueries(searchTitles),
                    fetch,
                    exclusions
                )
                const inferredEpisode = this.inferParallelEpisodeNumber(
                    titleOnlyResults,
                    localTarget.number
                )

                if (inferredEpisode != null) {
                    const inferredTarget = {
                        number: inferredEpisode,
                        label: `inferred episode ${inferredEpisode}`,
                        kind: 'inferred'
                    }
                    const inferredDirectResults = await this.fetchSingleTargetResults({
                        searchTitles,
                        target: inferredTarget,
                        resolution,
                        fetch,
                        exclusions
                    })
                    const inferredTitleOnlyResults = titleOnlyResults
                        .filter(result => !this.isBatchTitle(result.title))
                        .filter(result => this.matchesEpisodeNumber(
                            result.title,
                            inferredEpisode
                        ))
                    const localResults = await this.fetchSingleTargetResults({
                        searchTitles,
                        target: localTarget,
                        resolution,
                        fetch,
                        exclusions
                    })
                    const combinedResults = this.deduplicateResults([
                        ...inferredTitleOnlyResults,
                        ...inferredDirectResults,
                        ...localResults
                    ])

                    console.debug(
                        `[Nyaa] Inferred parallel episode ${inferredEpisode} ` +
                        `from season episode ${localTarget.number}: ` +
                        `${combinedResults.length} combined results`
                    )

                    if (combinedResults.length) {
                        return this.prepareSingleResults(
                            combinedResults,
                            titles,
                            resolution,
                            'medium'
                        )
                    }
                }
            }
        }

        if (localTarget) {
            const localResults = await this.fetchSingleTargetResults({
                searchTitles,
                target: localTarget,
                resolution,
                fetch,
                exclusions
            })

            if (localResults.length) {
                return this.prepareSingleResults(
                    localResults,
                    titles,
                    resolution,
                    'high'
                )
            }
        }

        return []
    }

    async fetchSingleTargetResults({
                                       searchTitles,
                                       target,
                                       resolution,
                                       fetch,
                                       exclusions
                                   }) {
        const queries = this.buildSingleQueries(
            searchTitles,
            [target],
            resolution
        )
        const results = await this.fetchQueries(
            queries,
            fetch,
            exclusions
        )

        return this.selectSingleEpisodeResults(
            results,
            [target]
        ).results
    }

    prepareSingleResults(
        results,
        titles,
        resolution,
        accuracy
    ) {
        return this.sortResults(
            results,
            titles,
            resolution
        ).map(result => ({
            ...result,
            accuracy
        }))
    }

    buildTitleOnlyQueries(searchTitles) {
        return [...new Set(
            searchTitles
                .slice(0, 2)
                .filter(Boolean)
        )]
    }

    inferParallelEpisodeNumber(results, localEpisode) {
        if (
            !Number.isInteger(localEpisode) ||
            localEpisode < 2
        ) {
            return null
        }

        const episodeNumbers = new Set(
            results
                .filter(result => !this.isBatchTitle(result.title))
                .map(result => this.extractSingleEpisodeNumber(
                    result.title
                ))
                .filter(episodeNumber =>
                    Number.isInteger(episodeNumber) &&
                    episodeNumber > 0
                )
        )

        /*
         * Require the local sequence to contain both the current
         * episode and its predecessor. For example, 1 and 2.
         */
        if (
            !episodeNumbers.has(localEpisode) ||
            !episodeNumbers.has(localEpisode - 1)
        ) {
            return null
        }

        /*
         * Find a higher parallel sequence containing the equivalent
         * current episode and its predecessor. For example, 41 and 42.
         */
        const inferredCandidates = [...episodeNumbers]
            .filter(episodeNumber =>
                episodeNumber > localEpisode + 1 &&
                episodeNumbers.has(episodeNumber - 1)
            )
            .sort((left, right) =>
                left - right
            )

        return inferredCandidates[0] ?? null
    }

    extractSingleEpisodeNumber(title) {
        const patterns = [
            /\bS\d{1,3}E0*(\d{1,4})(?:v\d+)?\b/i,
            /\b(?:EPISODE|EP|E)[ ._-]*0*(\d{1,4})(?:v\d+)?\b/i,
            /(?:^|[^A-Za-z0-9])#0*(\d{1,4})(?:v\d+)?(?=$|[^0-9.])/i,
            /(?:^|[\s._\[\](){}])[-–—][\s._-]*0*(\d{1,4})(?:v\d+)?(?=$|[\s._\[\](){}])/i,
            /[\[(]\s*0*(\d{1,4})(?:v\d+)?\s*[\])]/i,
            /(?:^|[\s._])0*(\d{1,4})(?:v\d+)?(?=\s*(?:\[|\(|$))/i
        ]

        for (const pattern of patterns) {
            const match = String(title ?? '').match(pattern)

            if (!match) continue

            const episodeNumber = Number(match[1])

            if (Number.isInteger(episodeNumber)) {
                return episodeNumber
            }
        }

        return null
    }

    async batch(query) {
        const {
            titles,
            episode,
            absoluteEpisodeNumber,
            exclusions = [],
            resolution,
            fetch
        } = query

        if (!titles?.length) return []

        if (typeof fetch !== 'function') {
            throw new Error('Hayase did not provide its CORS-enabled fetch function.')
        }

        const episodeTargets = this.getEpisodeTargets(
            episode,
            absoluteEpisodeNumber
        )
        const searchTitles = this.getSearchTitles(titles)
        const queries = this.buildBatchQueries(
            searchTitles,
            resolution
        )
        const results = await this.fetchQueries(
            queries,
            fetch,
            exclusions
        )

        console.debug(
            '[Nyaa] Batch candidate details: ' +
            JSON.stringify(
                results.map(result => ({
                    title: result.title,
                    date: result.date instanceof Date
                        ? result.date.toISOString()
                        : String(result.date),
                    seeders: result.seeders
                }))
            )
        )
        const match = this.selectBatchResults(
            results,
            episodeTargets
        )
        const batchResults = match.results.map(result => ({
            ...result,
            type: 'batch',
            accuracy: 'medium'
        }))

        console.debug(
            `[Nyaa] Batch targets ${this.formatEpisodeTargets(episodeTargets)}: ` +
            `${batchResults.length} batches matched ${match.target?.label ?? 'a complete batch'} ` +
            `from ${results.length} candidates`
        )

        return this.sortResults(
            batchResults,
            titles,
            resolution
        )
    }

    async movie(query) {
        const {
            titles,
            exclusions = [],
            resolution,
            fetch
        } = query

        if (!titles?.length) return []

        if (typeof fetch !== 'function') {
            throw new Error('Hayase did not provide its CORS-enabled fetch function.')
        }

        const searchTitles = this.getSearchTitles(titles)
        const queries = this.buildMovieQueries(
            searchTitles,
            resolution
        )
        const results = await this.fetchQueries(
            queries,
            fetch,
            exclusions
        )
        const movieResults = results
            .filter(result => !this.isBatchTitle(result.title))
            .map(result => ({
                ...result,
                accuracy: 'medium'
            }))

        return this.sortResults(
            movieResults,
            titles,
            resolution
        )
    }

    buildSingleQueries(
        searchTitles,
        episodeTargets,
        resolution
    ) {
        const resolutionTerm = this.getResolutionSearchTerm(
            resolution
        )
        const queries = []

        for (const target of episodeTargets) {
            for (const title of searchTitles.slice(0, 2)) {
                const episode = String(target.number)
                const paddedEpisode = Number.isInteger(target.number)
                    ? episode.padStart(2, '0')
                    : episode

                queries.push(this.joinSearchTerms(
                    title,
                    paddedEpisode,
                    resolutionTerm
                ))

                if (episode !== paddedEpisode) {
                    queries.push(this.joinSearchTerms(
                        title,
                        episode,
                        resolutionTerm
                    ))
                }
            }
        }

        return [...new Set(
            queries.filter(Boolean)
        )].slice(0, 8)
    }

    buildBatchQueries(searchTitles, resolution) {
        const resolutionTerm = this.getResolutionSearchTerm(
            resolution
        )
        const queries = []

        for (const title of searchTitles.slice(0, 2)) {
            queries.push(this.joinSearchTerms(
                title,
                'Batch',
                resolutionTerm
            ))

            queries.push(this.joinSearchTerms(
                title,
                'Complete',
                resolutionTerm
            ))

            /*
             * This broad query is safe because batch() filters every
             * response through isBatchTitle() before returning it.
             */
            queries.push(this.joinSearchTerms(
                title,
                resolutionTerm
            ))
        }

        return [...new Set(
            queries.filter(Boolean)
        )].slice(0, 6)
    }

    buildMovieQueries(searchTitles, resolution) {
        const resolutionTerm = this.getResolutionSearchTerm(
            resolution
        )

        return [...new Set(
            searchTitles
                .slice(0, 2)
                .map(title => this.joinSearchTerms(
                    title,
                    resolutionTerm
                ))
                .filter(Boolean)
        )]
    }

    async fetchQueries(queries, fetch, exclusions) {
        const allResults = []

        for (const query of queries) {
            const response = await fetch(
                this.buildFeedUrl(query)
            )

            if (!response.ok) {
                throw new Error(
                    `Nyaa.si returned HTTP ${response.status}.`
                )
            }

            const items = this.parseFeed(
                await response.text()
            )
            const results = items
                .map(item => this.mapResult(item))
                .filter(Boolean)
                .filter(result => this.matchesExclusions(
                    result,
                    exclusions
                ))

            console.debug(
                `[Nyaa] ${query}: ${items.length} RSS items, ` +
                `${results.length} usable results`
            )

            allResults.push(...results)
        }

        return this.deduplicateResults(allResults)
    }

    buildFeedUrl(query) {
        const params = new URLSearchParams({
            page: 'rss',
            q: query,
            c: '1_0',
            f: '0',
            s: 'seeders',
            o: 'desc'
        })

        return this.base + '/?' + params.toString()
    }

    joinSearchTerms(...terms) {
        return terms
            .filter(term =>
                term != null &&
                String(term).trim()
            )
            .map(term => String(term).trim())
            .join(' ')
    }

    getSearchTitles(titles) {
        const usableTitles = [...new Set(
            titles
                .filter(title =>
                    typeof title === 'string' &&
                    title.trim()
                )
                .map(title => this.cleanSearchTitle(title))
                .filter(Boolean)
        )]
        const latinTitles = usableTitles.filter(title =>
            /[A-Za-z]/.test(title)
        )

        return latinTitles.length
            ? latinTitles
            : usableTitles
    }

    getBroadSearchTitles(titles, exactTitles) {
        const exactTitleSet = new Set(
            exactTitles.map(title => title.toLowerCase())
        )
        const variants = []

        const addVariant = value => {
            const cleaned = this.cleanSearchTitle(value)
            const tokens = this.tokenizeTitle(cleaned)

            if (
                !cleaned ||
                exactTitleSet.has(cleaned.toLowerCase()) ||
                cleaned.length < 5 ||
                (tokens.length === 1 && tokens[0].length < 5)
            ) {
                return
            }

            if (!variants.some(existing =>
                existing.toLowerCase() === cleaned.toLowerCase()
            )) {
                variants.push(cleaned)
            }
        }

        for (const title of titles) {
            if (typeof title !== 'string' || !title.trim()) {
                continue
            }

            const normalized = title
                .replace(/\s+/g, ' ')
                .trim()
            const segments = normalized
                .split(/\s+(?:-|–|—)\s+|:\s*/)
                .map(segment => segment.trim())
                .filter(Boolean)

            for (
                let length = segments.length - 1;
                length >= 1;
                length--
            ) {
                addVariant(
                    segments.slice(0, length).join(' ')
                )
            }

            addVariant(normalized.replace(
                /\s*[\[(](?:part|cour|season)\s*[^\])]*[\])]\s*$/i,
                ''
            ))

            addVariant(normalized.replace(
                /\s+(?:part|cour|season)\s*\d+.*$/i,
                ''
            ))
        }

        const latinVariants = variants.filter(title =>
            /[A-Za-z]/.test(title)
        )
        const pool = latinVariants.length
            ? latinVariants
            : variants

        return pool
            .sort((left, right) =>
                this.tokenizeTitle(right).length -
                this.tokenizeTitle(left).length ||
                right.length - left.length
            )
            .slice(0, 2)
    }

    cleanSearchTitle(title) {
        return String(title ?? '')
            .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim()
    }

    getEpisodeTargets(
        episode,
        absoluteEpisodeNumber
    ) {
        const localEpisode = this.toEpisodeNumber(episode)
        const absoluteEpisode = this.toEpisodeNumber(
            absoluteEpisodeNumber
        )
        const targets = []

        /*
         * Prefer Hayase's absolute episode number whenever it differs
         * from the season-local number. This handles split cours and
         * season parts that Nyaa uploaders continue numbering across.
         */
        if (
            absoluteEpisode != null &&
            absoluteEpisode !== localEpisode
        ) {
            targets.push({
                number: absoluteEpisode,
                label: `absolute episode ${absoluteEpisode}`,
                kind: 'absolute'
            })
        }

        if (localEpisode != null) {
            targets.push({
                number: localEpisode,
                label: `season episode ${localEpisode}`,
                kind: 'local'
            })
        }

        if (
            absoluteEpisode != null &&
            !targets.some(target =>
                target.number === absoluteEpisode
            )
        ) {
            targets.push({
                number: absoluteEpisode,
                label: `episode ${absoluteEpisode}`,
                kind: 'absolute'
            })
        }

        return targets
    }

    toEpisodeNumber(value) {
        if (
            value == null ||
            !Number.isFinite(Number(value))
        ) {
            return null
        }

        return Number(value)
    }

    formatEpisodeTargets(targets) {
        return targets.length
            ? targets.map(target => target.label).join(', then ')
            : 'none'
    }

    selectSingleEpisodeResults(results, episodeTargets) {
        const singleResults = results.filter(result =>
            !this.isBatchTitle(result.title)
        )

        for (const target of episodeTargets) {
            const matches = singleResults.filter(result =>
                this.matchesEpisodeNumber(
                    result.title,
                    target.number
                )
            )

            if (matches.length) {
                return {
                    target,
                    results: matches
                }
            }
        }

        return {
            target: null,
            results: []
        }
    }

    selectBatchResults(results, episodeTargets) {
        const batchResults = results.filter(result =>
            this.isBatchTitle(result.title)
        )

        if (!episodeTargets.length) {
            return {
                target: null,
                results: batchResults
            }
        }

        for (const target of episodeTargets) {
            const rangedMatches = batchResults.filter(result =>
                this.batchRangeContainsEpisode(
                    result.title,
                    target.number
                )
            )

            if (rangedMatches.length) {
                return {
                    target,
                    results: rangedMatches
                }
            }
        }

        const completeBatches = batchResults.filter(result =>
            !this.extractEpisodeRanges(result.title).length &&
            /\b(?:batch|complete)\b|全集/i.test(result.title)
        )

        return {
            target: null,
            results: completeBatches
        }
    }

    matchesEpisodeNumber(title, episode) {
        const rawEpisode = String(episode)
        const escapedEpisode = rawEpisode.replace(
            /[.*+?^${}()|[\]\\]/g,
            '\\$&'
        )
        const episodePattern = Number.isInteger(episode)
            ? `0*${escapedEpisode}`
            : escapedEpisode
        const versionPattern = '(?:v\\d+)?'
        const patterns = [
            /*
             * S02E05
             */
            new RegExp(
                `\\bS\\d{1,3}E${episodePattern}` +
                `${versionPattern}(?=$|[^0-9.])`,
                'i'
            ),

            /*
             * Episode 05, EP05 or E05
             */
            new RegExp(
                `\\b(?:EPISODE|EP|E)[ ._-]*` +
                `${episodePattern}${versionPattern}` +
                `(?=$|[^0-9.])`,
                'i'
            ),

            /*
             * #05
             */
            new RegExp(
                `(?:^|[^A-Za-z0-9])#${episodePattern}` +
                `${versionPattern}(?=$|[^0-9.])`,
                'i'
            ),

            /*
             * Common anime release format:
             * Anime Title - 05 [1080p]
             */
            new RegExp(
                `(?:^|[\\s._\\[\\](){}])` +
                `[-–—][\\s._-]*${episodePattern}` +
                `${versionPattern}` +
                `(?=$|[\\s._\\[\\](){}])`,
                'i'
            ),

            /*
             * Anime Title [05]
             */
            new RegExp(
                `[\\[(]\\s*${episodePattern}` +
                `${versionPattern}\\s*[\\])]`,
                'i'
            ),

            /*
             * Anime Title 05 [1080p]
             */
            new RegExp(
                `(?:^|[\\s._])${episodePattern}` +
                `${versionPattern}` +
                `(?=\\s*(?:\\[|\\(|$))`,
                'i'
            )
        ]

        return patterns.some(pattern =>
            pattern.test(title)
        )
    }

    isBatchTitle(title) {
        if (/\b(?:batch|complete)\b|全集/i.test(title)) {
            return true
        }

        return this.extractEpisodeRanges(title)
            .some(({start, end}) =>
                end > start
            )
    }

    extractEpisodeRanges(title) {
        const ranges = []
        const patterns = [
            /*
             * Episodes 01-12, E01-12 or EP 01-12
             */
            /\b(?:episodes?|eps?|e)[ ._-]*0*(\d{1,4})\s*[-~–]\s*0*(\d{1,4})\b/gi,

            /*
             * Title - 01-12 [1080p]
             */
            /(?:^|[\s._\[\](){}])0*(\d{1,3})\s*[-~–]\s*0*(\d{1,3})(?=$|[\s._\[\](){}])/g
        ]

        for (const pattern of patterns) {
            for (
                const match of String(title ?? '')
                .matchAll(pattern)
                ) {
                const prefix = title.slice(
                    0,
                    match.index ?? 0
                )

                /*
                 * Do not interpret "Season 2 - 12" as
                 * an episode range.
                 */
                if (/\bseason\s*$/i.test(prefix)) {
                    continue
                }

                const start = Number(match[1])
                const end = Number(match[2])

                if (
                    Number.isFinite(start) &&
                    Number.isFinite(end)
                ) {
                    ranges.push({
                        start,
                        end
                    })
                }
            }
        }

        return ranges
    }

    batchRangeContainsEpisode(title, episode) {
        return this.extractEpisodeRanges(title)
            .some(({start, end}) =>
                episode >= Math.min(start, end) &&
                episode <= Math.max(start, end)
            )
    }

    matchesExclusions(result, exclusions) {
        const title = result.title.toLowerCase()

        return !exclusions
            .filter(exclusion =>
                typeof exclusion === 'string' &&
                exclusion.trim()
            )
            .some(exclusion =>
                title.includes(
                    exclusion.toLowerCase()
                )
            )
    }

    sortResults(results, titles, resolution) {
        return [...results].sort((left, right) => {
            const leftTitleScore = this.getTitleScore(
                left.title,
                titles
            )
            const rightTitleScore = this.getTitleScore(
                right.title,
                titles
            )
            const leftResolution = this.matchesResolution(
                left.title,
                resolution
            )
            const rightResolution = this.matchesResolution(
                right.title,
                resolution
            )

            /*
             * Date is intentionally not considered. Once an
             * episode is matched, prefer title accuracy,
             * resolution and availability.
             */
            return rightTitleScore - leftTitleScore ||
                Number(rightResolution) -
                Number(leftResolution) ||
                right.seeders - left.seeders ||
                right.downloads - left.downloads
        })
    }

    getTitleScore(resultTitle, titles) {
        const resultTokens = new Set(
            this.tokenizeTitle(resultTitle)
        )
        let bestScore = 0

        for (const title of titles) {
            const titleTokens = this.tokenizeTitle(title)
                .filter(token => ![
                    'a',
                    'an',
                    'the',
                    'season',
                    'part',
                    'cour',
                    'movie'
                ].includes(token))

            if (!titleTokens.length) continue

            const matches = titleTokens.filter(token =>
                resultTokens.has(token)
            ).length

            bestScore = Math.max(
                bestScore,
                matches / titleTokens.length
            )
        }

        return bestScore
    }

    tokenizeTitle(value) {
        return String(value ?? '')
            .normalize('NFKD')
            .replace(/\p{M}/gu, '')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, ' ')
            .trim()
            .split(/\s+/)
            .filter(Boolean)
    }

    matchesResolution(title, resolution) {
        const normalizedResolution = this.normalizeResolution(
            resolution
        )

        if (!normalizedResolution) return true

        const aliases = {
            '2160': [
                '2160p',
                '3840x2160',
                '4096x2160',
                '4k',
                'uhd'
            ],
            '1080': [
                '1080p',
                '1920x1080',
                'fhd'
            ],
            '720': [
                '720p',
                '1280x720'
            ],
            '540': [
                '540p',
                '960x540'
            ],
            '480': [
                '480p',
                '640x480',
                '720x480',
                '854x480'
            ]
        }

        return (
            aliases[normalizedResolution] ?? [
                normalizedResolution + 'p'
            ]
        ).some(alias => new RegExp(
            `(?:^|[^A-Za-z0-9])` +
            `${alias.replace(
                /[.*+?^${}()|[\]\\]/g,
                '\\$&'
            )}` +
            `(?:$|[^A-Za-z0-9])`,
            'i'
        ).test(title))
    }

    normalizeResolution(resolution) {
        return String(resolution ?? '')
            .trim()
            .replace(/p$/i, '')
    }

    getResolutionSearchTerm(resolution) {
        const normalizedResolution = this.normalizeResolution(
            resolution
        )

        return normalizedResolution
            ? normalizedResolution + 'p'
            : ''
    }

    parseFeed(xml) {
        if (
            typeof xml !== 'string' ||
            !/<rss\b/i.test(xml) ||
            !/<channel\b/i.test(xml)
        ) {
            throw new Error(
                'Nyaa.si did not return a valid RSS feed. ' +
                'The site may be unavailable or blocking ' +
                'the request.'
            )
        }

        return [...xml.matchAll(
            /<item\b[^>]*>([\s\S]*?)<\/item>/gi
        )]
            .map(match => match[1])
            .map(itemXml => ({
                title: this.getTagValue(
                    itemXml,
                    'title'
                ),
                link: this.getTagValue(
                    itemXml,
                    'link'
                ),
                guid: this.getTagValue(
                    itemXml,
                    'guid'
                ),
                pubDate: this.getTagValue(
                    itemXml,
                    'pubDate'
                ),
                hash: this.getTagValue(
                    itemXml,
                    'nyaa:infoHash'
                ),
                seeders: this.getTagValue(
                    itemXml,
                    'nyaa:seeders'
                ),
                leechers: this.getTagValue(
                    itemXml,
                    'nyaa:leechers'
                ),
                downloads: this.getTagValue(
                    itemXml,
                    'nyaa:downloads'
                ),
                size: this.getTagValue(
                    itemXml,
                    'nyaa:size'
                )
            }))
    }

    getTagValue(xml, tagName) {
        const escapedTagName = tagName.replace(
            /[.*+?^${}()|[\]\\]/g,
            '\\$&'
        )
        const match = xml.match(new RegExp(
            `<${escapedTagName}(?:\\s[^>]*)?>` +
            `([\\s\\S]*?)` +
            `<\\/${escapedTagName}>`,
            'i'
        ))

        if (!match) return ''

        return this.decodeXml(
            match[1]
                .replace(/^\s*<!\[CDATA\[/, '')
                .replace(/\]\]>\s*$/, '')
                .trim()
        )
    }

    decodeXml(value) {
        const entities = {
            amp: '&',
            apos: "'",
            gt: '>',
            lt: '<',
            quot: '"'
        }

        return String(value ?? '')
            .replace(
                /&#x([0-9a-f]+);/gi,
                (_, code) => String.fromCodePoint(
                    Number.parseInt(code, 16)
                )
            )
            .replace(
                /&#(\d+);/g,
                (_, code) => String.fromCodePoint(
                    Number.parseInt(code, 10)
                )
            )
            .replace(
                /&(amp|apos|gt|lt|quot);/gi,
                (_, entity) =>
                    entities[entity.toLowerCase()]
            )
    }

    mapResult(item) {
        const title = String(
            item.title ?? ''
        ).trim()
        const hash = String(
            item.hash ?? ''
        )
            .trim()
            .toLowerCase()

        if (
            !title ||
            !/^[a-f0-9]{40}$/i.test(hash)
        ) {
            return null
        }

        const result = {
            title,
            link: hash,
            hash,
            seeders: this.toNumber(item.seeders),
            leechers: this.toNumber(item.leechers),
            downloads: this.toNumber(item.downloads),
            size: this.parseSize(item.size),
            date: this.parseDate(item.pubDate),
            accuracy: 'medium'
        }
        const id = this.extractId(
            item.guid || item.link
        )

        if (id != null) {
            result.id = id
        }

        return result
    }

    extractId(value) {
        const match = String(value ?? '').match(
            /\/(?:view|download)\/(\d+)/i
        )

        if (!match) return null

        const id = Number(match[1])

        return Number.isSafeInteger(id)
            ? id
            : null
    }

    deduplicateResults(results) {
        const seen = new Set()

        return results.filter(result => {
            if (seen.has(result.hash)) {
                return false
            }

            seen.add(result.hash)

            return true
        })
    }

    toNumber(value) {
        const parsed = Number(
            String(value ?? '')
                .replace(/,/g, '')
                .trim()
        )

        return Number.isFinite(parsed)
            ? parsed
            : 0
    }

    parseSize(value) {
        const normalized = String(value ?? '')
            .replace(/,/g, '')
            .trim()
        const directNumber = Number(normalized)

        if (Number.isFinite(directNumber)) {
            return directNumber
        }

        const match = normalized.match(
            /^([\d.]+)\s*([KMGTPE]?i?B)$/i
        )

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

        if (
            !Number.isFinite(amount) ||
            power == null
        ) {
            return 0
        }

        return Math.round(
            amount * Math.pow(
                unit.includes('I')
                    ? 1024
                    : 1000,
                power
            )
        )
    }

    parseDate(value) {
        const date = new Date(value || 0)

        return Number.isNaN(date.getTime())
            ? new Date(0)
            : date
    }

    async test() {
        return true
    }
}()