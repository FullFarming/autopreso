// Built-in industry glossary presets. Selecting one fills glossary + domain +
// language pair together so a session is meeting-ready in one click.
// Source of truth: docs/glossary-*.txt — regenerate with scripts in git history.

import { GLOSSARY_PRESET_LIBRARY } from "./glossary-preset-library.js";

export const GLOSSARY_PRESETS = [
  {
    id: "hotel-investment-en-ko",
    label: "호텔 투자 (EN↔KO)",
    industry: "상업용 부동산 — 호텔/호스피탈리티 투자",
    languagePair: { a: "en", b: "ko" },
    domain: "Commercial real estate — hotel/hospitality investment, development, and asset management. A live bilingual (KO/EN) investor presentation and panel session. All ambiguous terms take their CRE/hospitality-investment sense (conversion = 용도전환/호텔 전환, operator = 운영사, exit = 투자 회수).",
    glossary: "[규칙]\n- 아래는 대칭 용어쌍이다. 한→영, 영→한 어느 방향이든 원문에 한쪽이 나오면 반드시 그 짝으로 옮긴다.\n- 약어는 양방향 모두 원문 그대로 유지(번역 금지): MRG, DSCR, CAPEX, OPEX, RevPAR, TRevPAR, GOPPAR, GOP, OCC, ADR, CAGR, NOI, LTV, IRR, FF&E, OS&E, PIP, MEP, BOH, FOH, F&B, HMA, LOI, MOU, REIT, Q&A, Rent-free, Step-up Rent, Revenue-linked Rent, Base + Turnover Rent, Value-Add, Cap Rate, Exit, Buyer Pool, Cross-over Point\n- 회사명 동일 지칭: 쿠시먼앤드웨이크필드 / 쿠시먼 / Cushman & Wakefield / C&W 는 모두 같은 회사를 가리킨다. 어느 표기가 들리든 영어 출력은 Cushman & Wakefield(코리아 법인은 Cushman & Wakefield Korea), 한국어 출력은 쿠시먼앤드웨이크필드(코리아 법인은 쿠시먼앤드웨이크필드 코리아)로 통일한다. C&W Hospitality Advisory Services 는 번역하지 않는다.\n- 쿠시먼앤드웨이크필드코리아 / 쿠시먼앤드웨이크필드 코리아 / Cushman & Wakefield Korea / C&W Korea 는 한국 법인이다(붙여서 한 단어처럼 들려도 회사명+코리아로 인식): 영어 출력 Cushman & Wakefield Korea, 한국어 출력 쿠시먼앤드웨이크필드 코리아. 회사명이 또렷이 들리지 않으면 임의로 다른 문장을 지어내지 말 것.\n쿠시먼앤드웨이크필드 코리아 = Cushman & Wakefield Korea\n쿠시먼앤드웨이크필드코리아 = Cushman & Wakefield Korea\n쿠시먼 코리아 = Cushman & Wakefield Korea\n쿠시먼앤드웨이크필드 = Cushman & Wakefield\n쿠시먼 = Cushman & Wakefield\n- 고유명사 표기 고정: Hilton = 힐튼 / TheHyoosik = 더휴식 / First Cabin = 퍼스트 캐빈 / Timework Myeongdong = 타임워크 명동 / NOOn square = 눈스퀘어 / Myeongdong = 명동\n\n[관용·비유 표현 — 의미로 번역, 직역 절대 금지]\n현주소 = current landscape (\"현재 상황\"의 뜻. NEVER \"current address\")\n전망 = outlook\n변곡점 = inflection point\n분수령 = watershed moment\n숙제 = remaining challenge (NEVER \"homework\")\n온도차 = difference in sentiment\n눈높이 = expectations (눈높이 차이 = expectation gap)\n잣대 = yardstick\n허들 / 문턱 = hurdle / barrier\n문턱이 높다 = high barrier to entry\n발목을 잡다 = hold back / weigh on\n숨통이 트이다 = get breathing room\n숨 고르기 = pause for consolidation\n바닥을 다지다 = bottom out\n반등 = rebound\n훈풍 = tailwind\n역풍 = headwind\n청신호 = green light / positive signal\n적신호 = red flag\n옥석 가리기 = separating the wheat from the chaff (selective screening)\n손바뀜 = change of hands (ownership transfer)\n큰손 = major investor\n물꼬를 트다 = pave the way\n가시화되다 = take shape / materialize\n본격화되다 = gain momentum in earnest\n지각변동 = seismic shift\n판이 커지다 = the market is expanding\n몸집을 키우다 / 줄이다 = scale up / downsize\n양날의 검 = double-edged sword\n줄다리기 = tug-of-war (negotiation standoff)\n첫발을 떼다 = take the first step\n공전되다(협상이) = stall (negotiations)\n짚어보다 = examine / walk through\n받쳐주다(구조가) = underpin / support\n\n[일반 관용 표현 (한국어 = English) — 의미로, 가능하면 관용구로]\n큰 그림 = big picture\n두 마리 토끼를 잡다 = achieve both at once\n한 발 앞서다 = stay one step ahead\n걸음마 단계 = nascent stage\n탄력을 받다 = gain traction\n박차를 가하다 = accelerate efforts\n제동이 걸리다 = be curbed\n급물살을 타다 = gain rapid momentum\n가닥이 잡히다 = take shape\n윤곽이 드러나다 = the contours are emerging\n첫 삽을 뜨다 = break ground\n시동을 걸다 = kick off\n신호탄 = opening salvo\n기로에 서다 = stand at a crossroads\n시험대에 오르다 = be put to the test\n도마 위에 오르다 = come under scrutiny\n뜨거운 감자 = hot potato\n빙산의 일각 = tip of the iceberg\n동전의 양면 = two sides of the same coin\n그림의 떡 = pie in the sky\n빛 좋은 개살구 = all show and no substance\n계륵 = awkward asset (hard to keep, hard to drop)\n안갯속 = up in the air\n시계제로 = deep uncertainty (zero visibility)\n장밋빛 전망 = rosy outlook\n먹구름이 끼다 = dark clouds on the horizon\n가뭄에 단비 = much-needed relief\n엎친 데 덮친 격 = double whammy\n산 넘어 산 = one hurdle after another\n발등에 불이 떨어지다 = under urgent pressure\n물 들어올 때 노 젓다 = strike while the iron is hot\n노른자 땅 / 금싸라기 땅 = prime location\n숨은 보석 = hidden gem\n러브콜 = strong overtures (NEVER \"love call\")\n베일을 벗다 = be unveiled\n둥지를 틀다 = set up shop\n몸을 사리다 = play it safe\n눈치를 보다 = read the room\n입을 모으다 = unanimously agree\n마중물 = pump-priming catalyst\n청사진 = blueprint\n\n[일반 관용 표현 (English = 한국어)]\nbig picture = 큰 그림\ndeep dive = 심층 분석\non the same page = 인식을 같이하다\nelephant in the room = 모두 알지만 꺼내지 않는 문제\nsilver lining = 한 줄기 희망\nno silver bullet = 만능 해법은 없다\nacross the board = 전반에 걸쳐\nback to the drawing board = 원점에서 재검토\nin the same boat = 같은 처지\npain point = 애로사항 (페인포인트)\nblind spot = 사각지대\nbottleneck = 병목\nsnowball effect = 눈덩이 효과\ndomino effect = 도미노 효과\nchicken-and-egg = 닭이 먼저냐 달걀이 먼저냐 하는 문제\napples-to-apples = 동일 조건 비교\nthe devil is in the details = 악마는 디테일에 있다\nwhen the dust settles = 상황이 정리되면\nahead of the curve = 한발 앞선\nbehind the curve = 뒤처진\nnew normal = 뉴노멀\nperfect storm = 퍼펙트 스톰 (악재가 겹친 상황)\ncanary in the coal mine = 위험의 전조\nkick the can down the road = 문제를 뒤로 미루다\nbite the bullet = 감수하고 결단하다\nbenchmark = 벤치마크 (기준점)\nbest practice = 모범 사례\nlearning curve = 학습 곡선\nread the room = 분위기를 읽다\ntouch base = 가볍게 논의하다\ncircle back = 다시 짚다\n\n[영어 관용 표현 = 한국어 관용 표현 — 관용구는 관용구로 (idiom-for-idiom)]\ndry powder = 대기 자금 (미집행 투자금)\nflight to quality = 우량 자산 선호 (플라이트 투 퀄리티)\nflight to value = 가성비 자산 선호\ntrophy asset = 트로피 자산 (랜드마크급 자산)\ndistressed asset = 부실 자산\ncash cow = 캐시카우 (안정적 수익원)\nwhite elephant = 돈 먹는 애물단지\nlow-hanging fruit = 손쉽게 잡을 수 있는 기회\nmove the needle = 유의미한 변화를 만들다\ngame changer = 판도를 바꾸는 요인\nsweet spot = 최적 지점\ntipping point = 임계점\ninflection point = 변곡점\nsoft landing = 연착륙\nhard landing = 경착륙\ncorrection = (시장) 조정\nbubble = 거품\noverheated = 과열된\nbullish = 낙관적 (강세)\nbearish = 비관적 (약세)\nwait-and-see = 관망세\nheadwinds = 역풍\ntailwinds = 훈풍\ndouble down = 더 과감히 베팅하다\nskin in the game = 직접 자본을 투입한 이해관계\ntable stakes = 기본 전제 조건\nin the pipeline = 추진 중인\non the table = 검토 대상에 올라 있는\noff the table = 논외가 된\nred tape = 행정 규제 (번거로운 절차)\nrule of thumb = 경험칙\nballpark figure = 대략적인 수치\nbottom line = 핵심 (재무 맥락에서는 순이익)\nuphill battle = 힘겨운 싸움\nwin-win = 상생\nlevel playing field = 공정한 경쟁 환경\nfirst mover advantage = 선점 효과\nland grab = 시장 선점 경쟁\nrace to the bottom = 출혈 경쟁\ntrack record = 트랙레코드 (실적)\ndue diligence = 실사\nseparating the wheat from the chaff = 옥석 가리기\nchange of hands = 손바뀜\n\n[용어쌍 (한국어 = English) — 시장/투자/거래]\n수급 = supply and demand\n수요 세그먼트 = demand segment\n인바운드 관광객 = inbound tourists\n공급 부족 = supply constraints\n신규 공급 = new supply\n운영사 = operator\n자산운용사 = asset manager\n시행사 = developer\n시공사 = contractor\n금융기관 = lender\n대주단 = lender syndicate\n임차인 = tenant\n임대구조 = lease structure\n임대료 = rent\n책임임차 = master lease\n위탁운영 = management contract\n공실률 = vacancy rate\n전대 = sublease\n레버리지 조달 = leverage financing\n금융 조달 = debt financing\n수익률 = yield\n감정평가 = appraisal\n실거래가 = transaction price\n매각 = disposition\n인수 = acquisition\n선매입 = forward purchase\n입찰 = tender\n우선협상대상자 = preferred bidder\n인수의향서 = LOI\n양해각서 = MOU\n공모 = public offering\n사모 = private placement\n리츠 = REIT\n출구 전략 = exit strategy\n투자 회수 = exit\nExit 유동성 = exit liquidity\n재구조화 = restructuring\n투자 가능한 딜 = investable deal\n딜 소싱 = deal sourcing\n체계적 검증 = systematic validation\n실사 = due diligence\n용도변경 = change of use\n인허가 = permits and licensing\n관광진흥법 = Tourism Promotion Act\n준공업지역 = quasi-industrial area\n용적률 = floor area ratio (FAR)\n건폐율 = building coverage ratio\n착공 = groundbreaking\n준공 = completion\n증축 = extension\n리모델링 = renovation\n물리적 전환 가능성 = physical conversion feasibility\n신축 개발 = ground-up development\n기존 자산 활용 = repositioning existing assets\n브랜드 리포지셔닝 = brand repositioning\n컨버전(호텔 전환) = conversion\n기존 건물 재활용 = adaptive reuse\n\n[경제·금융 (한국어 = English) — 거시/금리]\n기준금리 = policy rate\n금리 인상 = rate hike\n금리 인하 = rate cut\n긴축 = tightening\n완화 = easing\n양적완화 = quantitative easing\n물가 상승 = inflation\n경기 침체 = recession\n경기 둔화 = slowdown\n경기 회복 = recovery\n환율 = exchange rate\n원화 약세 = weak won\n원화 강세 = strong won\n환헤지 = FX hedging\n유동성 = liquidity\n신용 경색 = credit crunch\n국채 금리 = government bond yield\n수익률 곡선 = yield curve\n변동성 = volatility\n투자심리 = investor sentiment\n안전자산 = safe-haven assets\n위험자산 = risk assets\n한국은행 = Bank of Korea\n연준 = the Fed\n\n[경제·금융 (한국어 = English) — 조달/구조]\n선순위 = senior (debt)\n중순위 = mezzanine\n후순위 = subordinated\n메자닌 = mezzanine\n가산금리 = spread\n변동금리 = floating rate\n고정금리 = fixed rate\n만기 = maturity\n차환 = refinancing\n원리금 = principal and interest\n상환 = repayment\n거치기간 = grace period\n담보 = collateral\n보증 = guarantee\n신용등급 = credit rating\n디폴트 = default\n부실채권 = non-performing loan (NPL)\n자기자본 = equity\n지분 투자 = equity investment\n출자 = equity contribution\n유상증자 = capital increase\n회사채 = corporate bonds\n대출 약정 = loan commitment\n인출 = drawdown\n\n[경제·금융 (한국어 = English) — 투자자/밸류에이션/거래]\n기관투자자 = institutional investors\n외국인 투자자 = foreign investors\n국부펀드 = sovereign wealth fund\n연기금 = pension funds\n공제회 = mutual aid association\n자산운용사 = asset manager\n증권사 = securities firm\n수탁고 = assets under management (AUM)\n대체투자 = alternative investments\n실물자산 = real assets\n포트폴리오 = portfolio\n분산투자 = diversification\n밸류에이션 = valuation\n멀티플 = multiple\n할인율 = discount rate\n현금흐름 = cash flow\n손익분기점 = breakeven point\n영업이익 = operating profit\n영업이익률 = operating margin\n감가상각 = depreciation\n재무제표 = financial statements\n공정가치 = fair value\n장부가 = book value\n배당 = dividend\n리스크 프리미엄 = risk premium\n인수합병 = M&A\n기업공개 = IPO\n상장 = listing\n매물 = asset on the market\n급매 = fire sale\n손절 = cut losses\n차익 실현 = profit taking\n저가 매수 = buying the dip\n고점 = peak\n저점 = trough\n박스권 = range-bound\n우상향 = upward trajectory\n워크아웃 = workout\n구조조정 = corporate restructuring\n청산 = liquidation\n※ 추가 약어 원문 유지: GDP, CPI, FOMC, EBITDA, DCF, NPL, AUM, M&A, IPO, QE\n\n[호텔업계 — 브랜드/계약 구조 (한국어 = English)]\n프랜차이즈 = franchise\n브랜드 사용료 = royalty fee\n위탁운영 수수료 = management fee\n기본 수수료 = base fee\n인센티브 수수료 = incentive fee\n키 머니 = key money\n기술지원계약 = technical services agreement (TSA)\n브랜드 제휴 = brand affiliation\n플래그 = flag (브랜드)\n리플래깅 = reflagging (브랜드 교체)\n화이트라벨 운영사 = white-label operator\n독립 호텔 = independent hotel\n체인 호텔 = chain hotel\n사전 개업 비용 = pre-opening expenses\n소프트 오프닝 = soft opening\n그랜드 오프닝 = grand opening\n\n[호텔업계 — 세그먼트/시설 유형 (한국어 = English)]\n럭셔리 = luxury\n어퍼 업스케일 = upper upscale\n업스케일 = upscale\n어퍼 미드스케일 = upper midscale\n이코노미 = economy\n부티크 호텔 = boutique hotel\n라이프스타일 호텔 = lifestyle hotel\n리조트 = resort\n비즈니스 호텔 = business hotel\n5성급 = five-star\n분양형 호텔 = condo hotel\n생활숙박시설(생숙) = serviced accommodation facility\n게스트하우스 = guesthouse\n\n[호텔업계 — 운영/수익 (한국어 = English)]\n객실 수 = keys (호텔 객실 수 단위)\n객실당 가격 = price per key\n객실 매출 = rooms revenue\n식음 매출 = F&B revenue\n부대 매출 = ancillary revenue\n연회·웨딩 = banquets and weddings\n마이스 = MICE\n단체 수요 = group demand\n개별 여행객 = FIT\n비즈니스 수요 = corporate demand\n레저 수요 = leisure demand\n블레저 = bleisure\n내국인 수요 = domestic demand\n평균 체류 기간 = average length of stay\n수익 관리 = revenue management\n다이내믹 프라이싱 = dynamic pricing\n직예약 = direct booking\n채널 믹스 = channel mix\n로열티 프로그램 = loyalty program\n업셀링 = upselling\n노쇼 = no-show\n오버부킹 = overbooking\n하우스키핑 = housekeeping\n컨시어지 = concierge\n셀프 체크인 = self check-in\n인력난 = labor shortage\n인건비 = labor costs\n외주화 = outsourcing\n※ 추가 약어 원문 유지: OTA, PMS, MICE, FIT, ALOS, TSA\n\n[호텔업계 — 개발/자산관리/시장 (한국어 = English)]\n신축 = new build\n증개축 = expansion and remodel\n인테리어 공사 = fit-out\n개보수 주기 = renovation cycle\nFF&E 적립금 = FF&E reserve\n자산 가치 제고 = asset enhancement\n자산관리 = asset management\n시설관리 = facility management\n노후화 = obsolescence\n좌초자산 = stranded asset\n운영자본 = working capital\n입지 = location\n상권 = trade area\n유동인구 = foot traffic\n접근성 = accessibility\n역세권 = station-adjacent area\n도심 = CBD\n경쟁군(컴셋) = competitive set\n수요 창출원 = demand generator\n계절성 = seasonality\n방한 외래객 = inbound visitors to Korea\n무비자 = visa-free\n항공 노선 = air routes\n환승 수요 = transit demand\n\n[용어쌍 (한국어 = English) — 호텔 운영/상품]\n객실 = guest room\n객실 점유율 = occupancy (OCC)\n평균 객실 요금 = average daily rate (ADR)\n객실당 매출 = RevPAR\n총영업이익 = gross operating profit (GOP)\n부대시설 = ancillary facilities\n연회장 = banquet hall\n스위트 = suite\n객실 믹스 = room mix\n상품성 = product competitiveness\n성수기 = peak season\n비수기 = off-season\n투숙객 = guests\n장기 투숙 = extended stay\n호캉스 = hotel staycation\n워케이션 = workcation\n운영 효율성 = operational efficiency\n수익성 = profitability\n브랜드 기준 = brand standards\n소프트 브랜드 = soft brand\n미드스케일 = midscale\n포커스드 서비스 = focused-service\n풀서비스 = full-service\n대체숙박 = alternative stay\n효율형 숙박 = efficient stay formats\n코리빙 = co-living\n캡슐호텔 = capsule hotel\n서비스드 레지던스 = serviced residence\n숙박시장 경계 확장 = expansion of hospitality boundaries\n좌장 = moderator\n\n[자산운용 (한국어 = English) — 펀드/비히클/보수]\n자산운용 = asset management\n자산운용사 = asset management company (asset manager)\n부동산 자산운용사 = real estate asset manager\n운용역 = fund manager\n펀드 = fund\n부동산펀드 = real estate fund\n블라인드 펀드 = blind-pool fund\n프로젝트 펀드 = project-specific fund\n개방형 펀드 = open-end fund\n폐쇄형 펀드 = closed-end fund\n펀드 설정 = fund formation\n펀드 만기 = fund maturity\n만기 연장 = maturity extension\n투자일임 = discretionary investment management\n위탁운용 = outsourced (delegated) management\n운용 보수 = management fee\n성과 보수 = performance fee (carried interest)\n기준 수익률 = hurdle rate\n캐피탈 콜 = capital call\n약정 출자금 = committed capital\n수익자 = beneficiary (fund investor)\n판매사 = distributor\n사무관리회사 = fund administrator\n신탁사 = trust company\n부동산신탁 = real estate trust\n수탁사 = trustee (custodian)\n자산관리회사(AMC) = asset management company (AMC)\n프로젝트금융투자회사 = project financing vehicle (PFV)\n특수목적법인 = special purpose company (SPC)\n투자기구 = investment vehicle\n코어 = Core\n코어플러스 = Core-plus\n밸류애드 = Value-add\n오퍼튜니스틱 = Opportunistic\n운용 전략 = investment strategy\n운용 자산 = assets under management\n투자심의위원회 = investment committee\n수익증권 = beneficiary certificates\n기관 자금 모집 = institutional fundraising\n출자 확약 = equity commitment\n공동투자 = co-investment\n클럽딜 = club deal\n※ 추가 약어 원문 유지: LP, GP, SPC, PFV, AMC, JV\n\n[호텔 브랜드 고유명사 (한국어 = English) — 표기 고정, 임의 번역 금지]\n힐튼 = Hilton\n콘래드 = Conrad\n월도프 아스토리아 = Waldorf Astoria\n더블트리 = DoubleTree\n메리어트 = Marriott\nJW 메리어트 = JW Marriott\n리츠칼튼 = The Ritz-Carlton\n웨스틴 = Westin\n쉐라톤 = Sheraton\n하얏트 = Hyatt\n그랜드 하얏트 = Grand Hyatt\n파크 하얏트 = Park Hyatt\n안다즈 = Andaz\n인터컨티넨탈 = InterContinental\n홀리데이 인 = Holiday Inn\n아코르 = Accor\n소피텔 = Sofitel\n노보텔 = Novotel\n이비스 = ibis\n페어몬트 = Fairmont\n포시즌스 = Four Seasons\n만다린 오리엔탈 = Mandarin Oriental\n반얀트리 = Banyan Tree\n켐핀스키 = Kempinski\n롯데호텔 = Lotte Hotel\n신라호텔 = The Shilla\n조선호텔 = Josun Hotels\n워커힐 = Walkerhill\n\n[추가 2026-06-17 — Hospitality Market Session 2026 Word 반영]\nPanel Discussion = 패널 토론\nIntegrated Q&A = 통합 Q&A\nSession Overview = 세션 개요\nSession Format = 세션 형식\nOpening Remarks = 오프닝 멘트\nModerator Opening = 좌장 오프닝\nPanelist Introduction = 패널 소개\nPossible Follow-up Questions = 후속 질문 후보군\nPossible Audience Q&A Topics = 예상 청중 질문 주제\nBrand Perspectives on the Seoul Hotel Market = 서울 호텔 시장에 대한 브랜드별 의견\nBrand Strategies for the Korea Market = 국내 시장에 대한 브랜드별 전략\nPerspectives on Development Trends in Korea = 국내 개발 트렌드에 대한 의견\nPerspectives on Midscale and Focused-Service Brands = Midscale 및 Focused-service 브랜드에 대한 의견\nglobal hotel brand = 글로벌 호텔 브랜드\ndomestic hospitality operator and developer = 국내 운영 및 개발사\nalternative stay brand = 대체숙박 브랜드\ndiverse stay formats = 다양한 숙박 포맷\nefficient stay formats = 효율형 숙박 포맷\ncompact room concepts = 컴팩트 객실 콘셉트\nefficient operating models = 효율형 운영 모델\nlocal operator = 국내 운영사\nlocal brand = 로컬 브랜드\nKorean consumer preferences = 국내 소비자 선호\noperating environment = 운영 환경\nbrand expansion strategy = 브랜드 확장 전략\nmarket approach = 시장 접근 전략\ngrowth strategy = 성장 전략\ngrowth opportunities = 성장 기회\nexpansion direction = 확장 방향\npriority segment = 우선 검토 세그먼트\ntarget customer segment = 타겟 고객층\nbrand segment = 브랜드 세그먼트\nglobal brand activity = 글로벌 브랜드 활동\nglobal brand perspective = 글로벌 브랜드 관점\nmarket competitiveness = 시장 경쟁력\nmarket perspective = 시장 관점\npractical perspective = 실질적인 관점\nrecovering demand = 수요 회복\nsupply constraints in Seoul = 서울 시장의 공급 부족\nhotel supply constraints = 호텔 공급 부족\nhotel investment and operating environment = 호텔 투자 및 운영 환경\nground-up development = 신축 개발\nValue-Add / Value Add = 밸류애드\nConversion = 컨버전\nRebranding = 리브랜딩\nRenovation = 리노베이션\nadaptive reuse = 기존 건물 재활용\nexisting asset utilization = 기존 자산 활용\nexisting asset renovation = 기존 자산 리노베이션\nFocused-service / Focused service / 포커스 서비스 = 포커스드 서비스\nMidscale = 미드스케일\nAlternative Stay = 대체숙박\nCapsule Hotel = 캡슐호텔\noperational efficiency = 운영 효율성\nprofitability = 수익성\ngrowth potential = 성장 가능성\nmarket potential = 시장 가능성\nMRG Gap / MRG 차이 / MRG 갭 문제 = MRG 갭\nMRG Structuring & Financing = MRG 구조화 및 금융 조달\nDSCR Threshold = DSCR 기준선\nDSCR requirement = DSCR 요건\nLTV requirement = LTV 요건\nfinancing structure = 금융 구조\ndebt financing = 대출 조달\ngap quantification = 갭 수치화\ngap bridge = 갭 해소\nRent-free = 렌트프리\nStep-up / Step-up Rent = 스텝업 임대료\nRevenue-linked Rent = 매출 연동 임대료\nBase + Turnover Rent = 기본 임대료 + 매출 연동 임대료\nExit Cap Rate = Exit Cap Rate\nExit Buyer Pool = Exit Buyer Pool\nBuyer Pool = Buyer Pool\nExit liquidity = Exit 유동성\nExit strategy = Exit 전략\nback-solving = 역산\ndeal structuring = 딜 구조화\nphysical conversion feasibility = 물리적 전환 가능성\nphysical layer = 물리 레이어\ncommercial layer = 상업 레이어\nregulatory layer = 규제 레이어\noperating layer = 운영 레이어\nMEP = MEP\nplumbing and drainage = 급배수\nHVAC = 공조\nfire safety = 소방\nroom module = 객실 모듈\nbathroom layout = 욕실 배치\nBOH circulation = BOH 동선\npermit route / licensing route = 인허가 경로\nTourism Promotion Act = 관광진흥법\nJung-gu working-level process = 중구 실무 경로\noperator screening = 운영사 선별\noperator reliability = 운영사 신뢰도\nreservation platform = 예약 플랫폼\nhygiene standards = 위생 기준\nreview sensitivity = 리뷰 민감도\n6-Step Validation Framework = 6단계 검증 프레임워크\nCAPEX estimate = CAPEX 추정\nthree-party coordination = 3자 조율\nHilton / TheHyoosik / First Cabin = 힐튼 / 더휴식 / 퍼스트 캐빈\nTimework Myeongdong = 타임워크 명동\nNOOn square Capsule Hotel = 눈스퀘어 캡슐호텔",
  },
  {
    id: "fnb-leasing-ko-ja",
    label: "F&B 임차 유치 (KO↔JA)",
    industry: "상업용 부동산 — 리테일 임대차/F&B",
    languagePair: { a: "ko", b: "ja" },
    domain: "Commercial real estate retail leasing — attracting F&B brands as tenants into office building retail space (e.g. corporate HQ low floors). Korean↔Japanese business meeting. Ambiguous terms take their retail-leasing sense (테넌트 = tenant brand, 입점 = 出店).",
    glossary: "[규칙]\n- 아래는 대칭 용어쌍이다. 한→일, 일→한 어느 방향이든 원문에 한쪽이 나오면 반드시 그 짝으로 옮긴다.\n- 약어·단위는 양방향 원문 유지: F&B, MD, LOI, MOU, NDA, 평(坪), ㎡\n- 회사·브랜드 고유명사는 양방향 원문 그대로 유지 (번역·음차 금지)\n\n[일본어 비즈니스 관용 표현 — 의미로 번역, 직역 금지]\n落とし所 = 절충점\n持ち帰って検討します = 내부 검토 후 회신드리겠습니다\n前向きに検討します = 긍정적으로 검토하겠습니다\nたたき台 = 검토용 초안\nすり合わせ = 사전 조율\n棲み分け = 영역 구분 (차별화 포지셔닝)\n目線 = 눈높이 (賃料目線 = 임대료 기대 수준)\n相場 = 시세\n折り合いをつける = 절충하다\n肌感覚 = 체감\nざっくり = 대략\nキックオフ = 킥오프\nウィンウィン = 상생 (win-win)\n御社 = 귀사\n弊社 = 당사\nよろしくお願いいたします = 잘 부탁드립니다\n根回し = 사전 교섭 (사전 정지작업)\n二の足を踏む = 주저하다\n腑に落ちる = 납득이 가다\n足並みをそろえる = 보조를 맞추다\n風向きが変わる = 기류가 바뀌다\n雲行きが怪しい = 전망이 불투명해지다\n土俵に上がる = 협상 테이블에 오르다\n前倒し = 일정 앞당김\n後ろ倒し = 일정 연기\n棚上げ = 보류\n白紙に戻す = 백지화하다\n軌道に乗る = 궤도에 오르다\n採算が合う = 채산이 맞다\n元が取れる = 본전을 뽑다\n旗振り役 = 주도 역할\n目玉 = 간판 (目玉テナント = 간판 테넌트)\n鳴り物入り = 대대적인 홍보 속에\n肝いり = 역점 사업\n折り紙付き = 정평이 난\nお墨付き = 공인된 보증\n渡りに船 = 가뭄에 단비\nお荷物 = 애물단지\n\n[한·일 관용 표현 — 관용구는 관용구로 (양방향)]\n현주소 = 現在地 (現状. NEVER 住所)\n숙제 = 課題 (NEVER 宿題)\n일석이조 = 一石二鳥\n두 마리 토끼를 잡다 = 二兎を得る (一挙両得)\n큰 그림 = 全体像\n한 발 앞서다 = 一歩先んじる\n걸음마 단계 = 黎明期 (初期段階)\n탄력을 받다 = 弾みがつく\n박차를 가하다 = 拍車をかける\n제동이 걸리다 = ブレーキがかかる\n급물살을 타다 = 一気に進む\n가닥이 잡히다 = 方向性が固まる\n윤곽이 드러나다 = 輪郭が見えてくる\n첫 삽을 뜨다 = 着工する\n기로에 서다 = 岐路に立つ\n시험대에 오르다 = 試金石となる\n도마 위에 오르다 = 俎上に載る\n뜨거운 감자 = 扱いの難しい厄介な問題\n빙산의 일각 = 氷山の一角\n동전의 양면 = 表裏一体\n그림의 떡 = 絵に描いた餅\n빛 좋은 개살구 = 見かけ倒し\n안갯속 = 五里霧中\n장밋빛 전망 = バラ色の見通し\n먹구름이 끼다 = 暗雲が立ち込める\n가뭄에 단비 = 干天の慈雨\n엎친 데 덮친 격 = 泣きっ面に蜂\n산 넘어 산 = 一難去ってまた一難\n발등에 불이 떨어지다 = 尻に火がつく\n물 들어올 때 노 젓다 = 鉄は熱いうちに打て\n노른자 땅 / 금싸라기 땅 = 一等地\n숨은 보석 = 掘り出し物\n둥지를 틀다 = 拠点を構える\n몸을 사리다 = 慎重姿勢を取る\n눈치를 보다 = 空気を読む\n입을 모으다 = 口をそろえる\n마중물 = 呼び水\n청사진 = 青写真\n발목을 잡다 = 足かせになる\n훈풍 = 追い風\n역풍 = 逆風\n청신호 = 青信号 (好転の兆し)\n적신호 = 赤信号 (警戒信号)\n옥석 가리기 = 玉石の選別\n물꼬를 트다 = 道筋をつける\n양날의 검 = 諸刃の剣\n줄다리기 = 綱引き (交渉の駆け引き)\n우상향 = 右肩上がり\n정체(한계 도달) = 頭打ち\n고공행진 = 高止まり\n관망세 = 様子見\n연착륙 = 軟着陸\n우물 안 개구리 = 井の中の蛙\n등잔 밑이 어둡다 = 灯台下暗し\n누워서 떡 먹기 / 식은 죽 먹기 = 朝飯前\n티끌 모아 태산 = 塵も積もれば山となる\n백문이 불여일견 = 百聞は一見に如かず\n어부지리 = 漁夫の利\n타산지석 = 他山の石\n진퇴양난 = 板挟み\n사면초가 = 四面楚歌\n임기응변 = 臨機応変\n적재적소 = 適材適所\n일사천리 = とんとん拍子\n우왕좌왕 = 右往左往\n시행착오 = 試行錯誤\n정면돌파 = 正面突破\n급할수록 돌아가라 = 急がば回れ\n상생 = ウィンウィン (共存共栄)\n\n[임대차 기본 (한국어 = 日本語)]\n임대인 = 貸主 (オーナー)\n임차인 = テナント (借主)\n임대차계약 = 賃貸借契約\n보증금 = 保証金\n월 임대료 = 月額賃料\n관리비 = 共益費\n권리금 = 権利金 (韓国特有の営業権プレミアム)\n렌트프리 = フリーレント\n평당 임대료 = 坪単価\n전대 = 転貸\n중도해지 = 中途解約\n위약금 = 違約金\n원상복구 = 原状回復\n계약 갱신 = 契約更新\n계약 기간 = 契約期間\n명도 = 明け渡し\n입주 = 入居\n공실 = 空室\n임대 조건 = 賃貸条件\n조건 협상 = 条件交渉\n제안서 = 提案書\n견적 = 見積もり\n의향서 = 意向書 (LOI)\n중개 = 仲介\n수수료 = 手数料\n실사 = デューデリジェンス\n계약 체결 = 契約締結\n\n[리테일 입점 (한국어 = 日本語)]\n입점 = 出店\n출점 전략 = 出店戦略\n키테넌트 = キーテナント\n앵커테넌트 = アンカーテナント\n테넌트 믹스 (MD구성) = テナントミックス (MD構成)\n팝업스토어 = ポップアップストア\n플래그십 스토어 = 旗艦店 (フラッグシップストア)\n로드샵 = 路面店\n매장 = 店舗\n1호점 = 一号店\n상권 = 商圏\n유동인구 = 通行量 (人通り)\n집객 = 集客\n집객력 = 集客力\n매출 연동 임대료 = 売上歩合賃料\n고정 임대료 = 固定賃料\n전용면적 = 専有面積\n공용면적 = 共用面積\n인테리어 공사 = 内装工事\n골조 상태 (스켈레톤) = スケルトン\n시설 인수 인도 (거치 양도) = 居抜き\n간판 = 看板\n영업시간 = 営業時間\n리뉴얼 = リニューアル\n\n[F&B 운영 (한국어 = 日本語)]\n식음 (F&B) = 飲食 (F&B)\n외식업 = 外食産業\n식음 브랜드 = 飲食ブランド\n객단가 = 客単価\n회전율 = 回転率\n좌석 수 = 席数\n주방 = 厨房\n배기 설비 = 排気設備\n급배수 = 給排水\n그리스트랩 = グリストラップ\n영업허가 = 営業許可\n보건소 = 保健所\n심야영업 = 深夜営業\n테이크아웃 = テイクアウト\n배달 = デリバリー\n카페 = カフェ\n베이커리 = ベーカリー\n런치 수요 = ランチ需要\n직장인 수요 = オフィスワーカー需要\n미쉐린 = ミシュラン\n맛집 = 人気店 (有名グルメ店)\n웨이팅 = 行列 (待ち時間)\n브랜드 인지도 = ブランド認知度\n가맹점 = フランチャイズ店\n직영점 = 直営店\n\n[사옥/오피스 (한국어 = 日本語)]\n사옥 = 本社ビル (自社ビル)\n저층부 = 低層部\n로비 = ロビー\n구내식당 = 社員食堂\n입주사 = 入居企業\n임직원 = 役職員 (社員)\n어메니티 = アメニティ\n복합시설 = 複合施設\n준공 = 竣工\n공용공간 = 共用部",
  },
  {
    id: "hotel-investment-en-ja",
    label: "호텔 투자 (EN↔JA)",
    industry: "상업용 부동산 — 호텔/호스피탈리티 투자",
    languagePair: { a: "en", b: "ja" },
    domain: "Commercial real estate — hotel/hospitality investment, development, and asset management. A live bilingual (EN/JA) investor meeting or panel. All ambiguous terms take their CRE/hospitality-investment sense (conversion = 用途転換, operator = 運営会社, exit = 出口).",
    glossary: "[規則]\n- 以下は対称の用語ペア。EN→JA・JA→ENどちらの方向でも、原文に片方が現れたら必ずその対で訳す。\n- 略語は両方向とも原文のまま維持(翻訳禁止): MRG, DSCR, CAPEX, OPEX, RevPAR, TRevPAR, GOPPAR, GOP, OCC, ADR, CAGR, NOI, LTV, IRR, FF&E, OS&E, PIP, F&B, HMA, LOI, MOU, REIT, Cap Rate, MICE, FIT, OTA, PMS, AUM, NPL, M&A, IPO, GDP, CPI, EBITDA, DCF\n- 会社・ブランドの固有名詞は両方向とも原文のまま維持\n\n[English = 日本語 — 관용구는 관용구로 (idiom-for-idiom)]\nbig picture = 全体像\nkill two birds with one stone = 一石二鳥\nlow-hanging fruit = 手近な成果\ndouble-edged sword = 諸刃の剣\ntip of the iceberg = 氷山の一角\ntwo sides of the same coin = 表裏一体\npie in the sky = 絵に描いた餅\nelephant in the room = 誰もが見て見ぬふりをする問題\nsilver lining = 一筋の光明\nno silver bullet = 特効薬はない\nbottleneck = ボトルネック\nsnowball effect = 雪だるま式\ndomino effect = ドミノ効果 (連鎖反応)\nthe devil is in the details = 悪魔は細部に宿る\nahead of the curve = 時代の先を行く\nbehind the curve = 後手に回る\nnew normal = ニューノーマル\nperfect storm = パーフェクトストーム (複合危機)\ncanary in the coal mine = 炭鉱のカナリア (危険の前兆)\nkick the can down the road = 問題を先送りする\nbite the bullet = 腹をくくる\nread the room = 空気を読む\ntouch base = 軽くすり合わせる\ncircle back = 改めて確認する\nwin-win = ウィンウィン\ngame changer = ゲームチェンジャー\nsweet spot = スイートスポット (最適点)\ntipping point = 転換点\ninflection point = 変曲点\nsoft landing = 軟着陸 (ソフトランディング)\nhard landing = ハードランディング\nbullish = 強気\nbearish = 弱気\nwait-and-see = 様子見\non the same page = 認識を共有している\nback to the drawing board = 一から練り直す\napples-to-apples = 同一条件での比較\nwhen the dust settles = 事態が落ち着けば\nuphill battle = 苦しい戦い\nlevel playing field = 公平な競争条件\nfirst mover advantage = 先行者利益\nrace to the bottom = 消耗戦\nred tape = 煩雑な手続き\nrule of thumb = 経験則\nballpark figure = 概算値\nbottom line = 要点 (財務文脈では最終損益)\nstrike while the iron is hot = 鉄は熱いうちに打て\n\n[English = 日本語 — 투자·부동산 관용 표현]\ndry powder = 待機資金\nflight to quality = 質への逃避\ntrophy asset = トロフィー資産\ndistressed asset = ディストレスト資産 (不良資産)\ncash cow = ドル箱\nwhite elephant = 無用の長物\nmove the needle = 目に見える変化を生む\nskin in the game = 自己資金を投じた当事者意識\ntable stakes = 最低限の前提条件\nin the pipeline = 進行中\non the table = 検討の俎上にある\noff the table = 検討対象から外れた\ndouble down = 一段と注力する\nland grab = 市場の陣取り合戦\ntrack record = 実績 (トラックレコード)\nchange of hands = 持ち主の交代\nprime location = 一等地\nhidden gem = 掘り出し物\nblueprint = 青写真\npump-priming = 呼び水\nseparating the wheat from the chaff = 玉石の選別\n\n[用語ペア (English = 日本語) — 投資・取引]\noperator = 運営会社 (オペレーター)\nasset manager = アセットマネージャー\ndeveloper = デベロッパー\nlender = レンダー (金融機関)\nlender syndicate = 協調融資団\ntenant = テナント\nmaster lease = マスターリース\nmanagement contract = 運営委託契約\nfranchise = フランチャイズ\nvacancy rate = 空室率\nlease structure = 賃貸借スキーム\nrent = 賃料\nfixed rent = 固定賃料\nrevenue-linked rent = 売上連動賃料\nrent-free period = フリーレント\nyield = 利回り\nappraisal = 鑑定評価\ntransaction price = 成約価格\nacquisition = 取得\ndisposition = 売却\nforward purchase = フォワード購入\ntender = 入札\npreferred bidder = 優先交渉権者\nexit = 出口 (イグジット)\nexit strategy = 出口戦略\nexit liquidity = 出口流動性\nrestructuring = 再編 (リストラクチャリング)\ndeal sourcing = ディールソーシング\ndue diligence = デューデリジェンス\nchange of use = 用途変更\npermits and licensing = 許認可\nfloor area ratio (FAR) = 容積率\nbuilding coverage ratio = 建ぺい率\ngroundbreaking = 着工\ncompletion = 竣工\nrenovation = 改修 (リノベーション)\nconversion = 用途転換 (コンバージョン)\nadaptive reuse = 既存建物の再活用\nrepositioning = リポジショニング\nground-up development = 新築開発\n\n[経済・金融 (English = 日本語)]\npolicy rate = 政策金利\nrate hike = 利上げ\nrate cut = 利下げ\ntightening = 金融引き締め\neasing = 金融緩和\nquantitative easing = 量的緩和\ninflation = インフレ\nrecession = 景気後退\nslowdown = 景気減速\nrecovery = 景気回復\nexchange rate = 為替レート\nweak won = ウォン安\nstrong won = ウォン高\nFX hedging = 為替ヘッジ\nliquidity = 流動性\ncredit crunch = 信用収縮\ngovernment bond yield = 国債利回り\nyield curve = イールドカーブ\nvolatility = ボラティリティ\ninvestor sentiment = 投資家心理\nsafe-haven assets = 安全資産\nrisk assets = リスク資産\nsenior debt = シニアローン\nmezzanine = メザニン\nsubordinated = 劣後\nspread = スプレッド\nfloating rate = 変動金利\nfixed rate = 固定金利\nmaturity = 満期\nrefinancing = リファイナンス (借り換え)\ncollateral = 担保\nguarantee = 保証\ncredit rating = 信用格付け\ndefault = デフォルト\nnon-performing loan = 不良債権\nequity = エクイティ (自己資本)\nequity investment = 出資\ncapital increase = 増資\ncorporate bonds = 社債\ndrawdown = 資金引き出し\ninstitutional investors = 機関投資家\nforeign investors = 海外投資家\nsovereign wealth fund = 政府系ファンド\npension funds = 年金基金\nalternative investments = オルタナティブ投資\nreal assets = 実物資産\nportfolio = ポートフォリオ\ndiversification = 分散投資\nvaluation = バリュエーション\nmultiple = マルチプル\ndiscount rate = 割引率\ncash flow = キャッシュフロー\nbreakeven point = 損益分岐点\noperating profit = 営業利益\ndepreciation = 減価償却\nfair value = 公正価値\nbook value = 簿価\ndividend = 配当\nrisk premium = リスクプレミアム\nlisting = 上場\nfire sale = 投げ売り\nprofit taking = 利益確定\nbuying the dip = 押し目買い\npeak = ピーク (高値)\ntrough = 底 (安値)\nrange-bound = レンジ相場\nupward trajectory = 右肩上がり\nworkout = ワークアウト\nliquidation = 清算\n\n[ホテル業界 (English = 日本語)]\nkeys = 客室数 (キー)\nprice per key = 客室単価 (パー・キー)\nrooms revenue = 客室売上\nF&B revenue = 料飲売上\nancillary revenue = 付帯売上\nbanquets and weddings = 宴会・婚礼\ngroup demand = 団体需要\ncorporate demand = ビジネス需要\nleisure demand = レジャー需要\ndomestic demand = 国内需要\ninbound tourists = インバウンド観光客\naverage length of stay = 平均滞在日数\nrevenue management = レベニューマネジメント\ndynamic pricing = ダイナミックプライシング\ndirect booking = 直販予約\nchannel mix = チャネルミックス\nloyalty program = ロイヤルティプログラム\nupselling = アップセル\nno-show = ノーショー\noverbooking = オーバーブッキング\nhousekeeping = ハウスキーピング\nlabor shortage = 人手不足\nlabor costs = 人件費\noutsourcing = 外部委託\nluxury = ラグジュアリー\nupper upscale = アッパーアップスケール\nupscale = アップスケール\nmidscale = ミッドスケール\neconomy = エコノミー\nboutique hotel = ブティックホテル\nlifestyle hotel = ライフスタイルホテル\nresort = リゾート\nbusiness hotel = ビジネスホテル\nfull-service = フルサービス\nfocused-service = 宿泊特化型\nextended stay = 長期滞在\nserviced residence = サービスレジデンス\ncapsule hotel = カプセルホテル\nco-living = コリビング\nbrand standards = ブランド基準\nsoft brand = ソフトブランド\nreflagging = ブランド変更 (リフラッギング)\nkey money = キーマネー\nroyalty fee = ロイヤルティフィー\nbase fee = 基本報酬\nincentive fee = インセンティブフィー\ntechnical services agreement = 技術支援契約 (TSA)\npre-opening expenses = 開業準備費用\nsoft opening = ソフトオープン\ngrand opening = グランドオープン\nFF&E reserve = FF&E積立金\nasset enhancement = 資産価値向上\nasset management = アセットマネジメント\nfacility management = ファシリティマネジメント\nobsolescence = 陳腐化\nstranded asset = 座礁資産\nlocation = 立地\ntrade area = 商圏\nfoot traffic = 通行量\naccessibility = アクセス性\nCBD = 都心 (CBD)\ncompetitive set = 競合セット\ndemand generator = 需要創出源\nseasonality = 季節性\nvisa-free = ビザ免除\nair routes = 航空路線\nmoderator = モデレーター (座長)",
  },
  // 2026-07: the everyday DEFAULT (general CRE + AI/AX + idioms) and the
  // preserved hotel-session glossary — one-click switch between the daily
  // setup and hotel events. Appended last so first-run default resolution
  // (getDefaultSubtitleGlossaryContext picks the FIRST pair match) keeps the
  // richer hotel-investment preset, exactly as before.
  ...GLOSSARY_PRESET_LIBRARY,
];

for (const preset of GLOSSARY_PRESETS) preset.source = "built-in";

const HOSPITALITY_TRANSLATION_MEMORY = `[번역 메모리 — Hospitality Market Session 2026 문장 매칭]
서울 호텔 시장의 현 주소와 전망 = Current Landscape and Outlook for the Seoul Hotel Market
안녕하세요. C&W Hospitality Advisory Services입니다 = Hello. This is C&W Hospitality Advisory Services.
오늘 저는 서울 호텔 시장 이야기를 드리러 왔는데 = Today, I am here to discuss the Seoul hotel market.
시장이 좋다는 이야기를 하러 온 건 아닙니다 = I am not here simply to say that the market is strong.
좋은 시장에서도 왜 실제 투자로 이어지기 어려운지 = why even a strong market does not easily translate into actual investment
그 구조적 이유와, 그 안에서 딜을 만드는 방법 = the structural reasons behind that gap and how to create deals within it
물리적 전환 가능성 = physical conversion feasibility
호텔로 쓸 수 있냐 = whether the asset can be used as a hotel
운영사가 수용할 수 있는 상품이 되느냐 = whether it can become a product an operator can accept
MRG와 금융 구조 설계 = MRG and financing structure design
금융기관이 요구하는 숫자와 운영사가 실제로 감당할 수 있는 숫자 사이의 갭 = the gap between the numbers lenders require and the numbers operators can actually support
숙박시장 경계 확장 = expansion of hospitality boundaries
캡슐호텔, 코리빙 같은 대체숙박 = alternative stay formats such as capsule hotels and co-living
투자 가능한 딜이 완성됩니다 = an investable deal is completed
수요 그래프를 보시면 단순한 팬데믹 반등이 아니라, 구조적 상승임을 알 수 있습니다 = The demand chart shows not merely a post-pandemic rebound, but a structural increase.
ADR 상승이 OCC보다 훨씬 가파릅니다 = ADR is rising much more steeply than OCC.
방을 더 채운 게 아니라, 더 비싸게 팔 수 있게 됐다는 뜻입니다 = This means hotels are not just filling more rooms; they are able to sell rooms at higher rates.
지표는 좋은데 실행 가능한 딜이 없는 상황 = a market where the indicators are strong, but executable deals are scarce
브랜드, 운영사, 금융구조, 이 세 레이어가 동시에 맞아 떨어져야 비로소 작동합니다 = The brand, operator, and financing structure must all align for the deal to work.
체계적인 접근 없이는 딜을 완성하기 어렵습니다 = Without a systematic approach, it is difficult to complete a deal.
도면만 봐서는 규모를 가늠할 수 없습니다 = Drawings alone are not enough to estimate the scale.
실물 실사를 해봐야 압니다 = You only know after physical due diligence.
운영사를 처음부터 참여시키지 않으면 나중에 되돌리기가 힘들어집니다 = If the operator is not involved from the beginning, it becomes difficult to reverse course later.
MRG란 호텔 운영사가 임대인에게 보장하는 최소 수익입니다 = MRG is the minimum revenue that a hotel operator guarantees to the landlord.
이 갭이 좁혀지지 않으면 DSCR 기준선을 넘을 수 없습니다 = If this gap is not narrowed, the deal cannot meet the DSCR threshold.
모두 쓰는 게 아니라 조합이 중요합니다 = The point is not to use every tool, but to combine the right ones.
Rent-free는 초기 안정화가 필요한 신규 전환 물건에 유효합니다 = Rent-free periods are effective for newly converted assets that need initial stabilization.
Step-up은 금융기관이 가장 선호하는 구조 중 하나입니다 = Step-up rent is one of the structures lenders tend to prefer most.
Revenue-linked와 Base+Turnover는 오너와 운영사가 리스크를 나누는 방식입니다 = Revenue-linked rent and Base + Turnover rent are ways for the owner and operator to share risk.
지금 조달을 위한 구조가 나중에 매각할 때의 가격 논리와 충돌하면 안 됩니다 = The financing structure used today must not conflict with the pricing logic at exit.
그 갭을 숫자로 만드는 것이었습니다 = The first step was to quantify that gap.
현재 DSCR를 맞추는 데 집중하다 보면 Exit 구조가 망가지는 경우가 있습니다 = If you focus only on meeting current DSCR, the exit structure can be damaged.
기회는 분명 있습니다. 초기 자본이 적고, 속도가 빠르고, 수요층이 다양합니다 = The opportunity is clear: lower initial capital, faster execution, and diverse demand.
다만 기회만큼 검증도 반드시 선행되어야 합니다 = However, validation must come before the opportunity is pursued.
일반상업지역의 복합 쇼핑몰 = a mixed-use shopping mall in a general commercial district
관광숙박업 허가와 복합 용도 적합성 문제가 동시에 걸렸습니다 = tourism accommodation licensing and mixed-use compatibility were both at issue.
법령 조문보다 인허가 경로 설계가 먼저입니다 = Designing the licensing route comes before citing the statutory provisions.
예약 플랫폼이 약하거나 위생 기준이 불안정하면 리뷰 한 줄에 RevPAR가 흔들립니다 = If the reservation platform is weak or hygiene standards are inconsistent, a single review can affect RevPAR.
DESIGN은 단순한 인테리어가 아닙니다 = Design is not just interior decoration.
타겟 수요층을 먼저 정의해야 이 균형을 설계할 수 있습니다 = The target demand segment must be defined first to design this balance.
좋은 시장은 기회를 만들지만, 그 기회를 딜로 바꾸는 건 체계적인 검증에서 나옵니다 = A strong market creates opportunities, but turning those opportunities into deals comes from systematic validation.
토론 및 통합 Q&A 세션 : 국내 호텔 시장의 변화와 기회 = Panel Discussion and Integrated Q&A Session: Changes and Opportunities in Korea's Hotel Market
국내 호텔 시장의 변화와 기회 = Changes and Opportunities in Korea's Hotel Market
지금부터 국내 호텔 시장의 변화와 기회를 주제로 패널 토론 및 통합 Q&A 세션을 진행하겠습니다 = We will now begin our panel discussion and integrated Q&A session on Changes and Opportunities in Korea's Hotel Market.
오늘 세션은 글로벌 호텔 브랜드, 국내 운영 및 개발사, 그리고 새로운 숙박 포맷을 운영하는 브랜드가 함께 참여합니다 = Today's discussion brings together a global hotel brand, a domestic hospitality operator and developer, and an alternative stay brand.
최근 국내 호텔 시장의 변화와 각 사의 시장 관점을 보다 실질적인 관점에서 공유하는 자리입니다 = This session is designed to share practical perspectives on recent changes in Korea's hospitality market and each company's market view.
서울 시장에 대한 시각, 브랜드 확장 전략, Value-Add 및 Conversion 트렌드 = views on the Seoul market, brand expansion strategies, and value-add and conversion trends
Midscale 및 Focused-service 시장 확대 흐름 = the growing midscale and focused-service segments
서울 호텔 시장에 대한 브랜드별 의견 = Brand Perspectives on the Seoul Hotel Market
최근 서울 호텔 시장은 수요 회복과 함께 빠르게 확대되고 있는 시장으로 보입니다 = The Seoul hotel market appears to be expanding rapidly with recovering demand.
각 패널분들께서 현재 서울 시장을 어떻게 바라보고 계신지 자유롭게 의견을 부탁드립니다 = I would like to ask each panelist to share how you currently view the Seoul hotel market.
서울 시장에서 가장 매력적으로 보는 수요 세그먼트는 무엇인지 = Which demand segment do you currently find most attractive in Seoul?
국내 시장에 대한 브랜드별 전략 = Brand Strategies for the Korea Market
현재 국내 시장을 어떤 방향으로 접근하고 계신지 말씀 부탁드립니다 = Could each panelist share how your company is approaching growth opportunities in Korea?
국내 개발 트렌드에 대한 의견 공유 = Perspectives on Development Trends in Korea
Ground-up development와 Value-Add 전략 = ground-up development and value-add strategies
Conversion, Rebranding, Renovation 등 기존 자산을 활용한 Value-Add 전략 = value-add strategies using existing assets, such as conversion, rebranding, and renovation
Midscale 및 Focused-Service 브랜드에 대한 의견 = Perspectives on Midscale and Focused-Service Brands
효율 중심 브랜드 및 운영 구조 확대 = the growing importance of efficient hotel formats and operating models
컴팩트 객실 및 효율형 운영 모델의 경쟁력 = the competitiveness of compact room concepts and efficient operating models
지금부터는 앞서 발표 및 패널 토론 내용을 포함하여 청중분들과 함께 자유롭게 질의응답을 진행하겠습니다 = We will now open the floor for an integrated Q&A session covering both the presentations and today's panel discussion.
국내 호텔 시장이 단순 신규 개발 중심 시장에서 벗어나 다양한 숙박 포맷과 운영 전략, 그리고 기존 자산 활용 중심 시장으로 변화하고 있습니다 = Korea's hotel market is evolving beyond traditional new developments into a market shaped by diverse stay formats, operational strategies, and the repositioning of existing assets.`;

const HOSPITALITY_PANEL_260623_TERMS = `[추가 2026-06-23 — Hospitality Market Session 패널 3사 고유명사/약어/운영 용어]
- 실시간 출력이 빠르게 나오더라도 아래 고유명사는 음차를 새로 만들지 않는다. 특히 Cushman을 Kushi, Kushman, Kusiman, 쿠시만, 쿠쉬먼으로 쓰지 않는다.
- 브랜드명·프로그램명·약어는 문맥상 한국어 표기가 확립된 경우만 번역하고, 약어 자체는 보존한다: TPO, APAC, Q1, HGI, LXR, MEP, BOH, F&B, ADR, GOP, CapEx, CAPEX.
Kushi = Cushman & Wakefield
Kushman = Cushman & Wakefield
Kushiman = Cushman & Wakefield
Kusiman = Cushman & Wakefield
K-Field = Cushman & Wakefield
K-Field Korea = Cushman & Wakefield Korea
Kushi = 쿠시먼앤드웨이크필드
Kushman = 쿠시먼앤드웨이크필드
Kushiman = 쿠시먼앤드웨이크필드
Kusiman = 쿠시먼앤드웨이크필드
K-Field = 쿠시먼앤드웨이크필드
K-Field Korea = 쿠시먼앤드웨이크필드 코리아
쿠시만 = 쿠시먼앤드웨이크필드
쿠쉬먼 = 쿠시먼앤드웨이크필드
C&W = Cushman & Wakefield
C&W Korea = Cushman & Wakefield Korea
C&W = 쿠시먼앤드웨이크필드
C&W Korea = 쿠시먼앤드웨이크필드 코리아
C&W Hospitality = C&W Hospitality
C&W Korea Hospitality = C&W Korea Hospitality
The Hyoosik = 더휴식
TheHyoosik = 더휴식
THS = THS
First Cabin International = 퍼스트 캐빈 인터내셔널
First Cabin Myeongdong = 퍼스트 캐빈 명동
First Cabin = 퍼스트 캐빈
Noon Square / NOON Square / NOOn square / 눈스퀘어 = 눈스퀘어
NOOn square Capsule Hotel = 눈스퀘어 캡슐호텔
Peach Aviation-themed pods = 피치항공 테마 포드
Hilton Honors = 힐튼 아너스
Hilton Honors ecosystem = 힐튼 아너스 생태계
Hilton Honors Amex Card = Hilton Honors Amex Card
Hilton Honors Amex Premium Card = Hilton Honors Amex Premium Card
American Express = 아메리칸 익스프레스
Lotte Card = 롯데카드
INSPIRE = 인스파이어
HGI Busan Gijang = HGI 부산 기장
Waldorf Astoria = 월도프 아스토리아
Conrad = 콘래드
LXR = LXR
Hilton Garden Inn = 힐튼 가든 인
Hampton by Hilton = 햄튼 바이 힐튼
Spark by Hilton = 스파크 바이 힐튼
Motto by Hilton = 모토 바이 힐튼
Tapestry = 태피스트리
Seoul CBD = 서울 CBD
Seongsu = 성수
Hongdae = 홍대
Gangnam = 강남
Jongno = 종로
Dongdaemun = 동대문
Busan = 부산
Jeju = 제주
Ulsan = 울산
Daejeon = 대전
Suwon = 수원
Yeosu = 여수
East Coast = 동해안
Gangneung = 강릉
Sokcho = 속초
Yangyang = 양양
Honolulu = 호놀룰루
Waikiki = 와이키키
APAC = APAC
Asia Pacific = 아시아 태평양
Q1 = 1분기
Third-Party Operator / third-party operator = 써드파티 운영사
TPO = TPO
independent TPO = 독립 TPO
local operator = 로컬 운영사
local brand = 로컬 브랜드
global brand = 글로벌 브랜드
focused-service hotel = 포커스드 서비스 호텔
focused-service = 포커스드 서비스
midscale = 미드스케일
full-service = 풀서비스
lifestyle brand = 라이프스타일 브랜드
soft brand = 소프트 브랜드
portfolio approach = 포트폴리오 접근
brand portfolio = 브랜드 포트폴리오
gateway destination = 관문 도시
secondary city = 2선 도시
regional leisure market = 지역 레저 시장
resort destination = 리조트 목적지
conversion-friendly = 컨버전 친화적
conversion project = 컨버전 프로젝트
adaptive reuse = 기존 건물 재활용
repositioning existing assets = 기존 자산 리포지셔닝
revitalization of existing assets = 기존 자산 활성화
underutilized real estate = 저활용 부동산
floorplate dimensions = 플로어플레이트 치수
window placement = 창 위치
lift core location / lift core locations = 엘리베이터 코어 위치
room mix / rooms mix = 객실 믹스
kit-of-parts approach = kit-of-parts 방식
low manning model = 저인력 운영 모델
modular design = 모듈형 설계
brand prototype = 브랜드 프로토타입
management agreement = 위탁운영계약
franchise / franchising = 프랜차이즈 방식
network effect = 네트워크 효과
multi-unit relationship = 다점포 파트너십
standalone transaction = 단일 거래
commercial platform = 상업 플랫폼
global distribution = 글로벌 유통망
upfront CapEx / upfront CAPEX = 초기 CAPEX
fire life safety requirements = 소방·인명 안전 요건
structural integrity = 구조 안전성
MEP systems = MEP 시스템
commercial engine = 상업 엔진
signings = 계약 체결
openings = 개장
time-to-market = 시장 출시 속도
owner objective / owner objectives = 오너 목표
stakeholder / stakeholders = 이해관계자
authentic experience = 진정성 있는 경험
compact hotel = 컴팩트 호텔
compact accommodation = 컴팩트 숙박
compact stay = 컴팩트 스테이
capsule hotel = 캡슐호텔
pod / pods = 포드
economy pod / economy pods = 이코노미 포드
efficient stay format / efficient stay formats = 효율형 숙박 포맷
limited footprint = 제한된 면적
space productivity = 공간 생산성
operating efficiency = 운영 효율성
brand-building market = 브랜드 구축 시장
visual brand experience = 시각적 브랜드 경험
trend-sensitive consumer / trend-sensitive consumers = 트렌드 민감 소비자
high urban density = 높은 도시 밀도
transportation infrastructure = 교통 인프라
business and tourism demand = 비즈니스 및 관광 수요
real estate value creation partner = 부동산 가치 창출 파트너
property owner / property owners = 부동산 소유자
strategic partner / strategic partners = 전략적 파트너
sustainable portfolio = 지속 가능한 포트폴리오
오피스텔 = officetel
생활형숙박시설 = serviced accommodation facility
업무시설 = office facility
기존 숙박시설 = existing lodging asset
관광호텔 = tourist hotel
운영 동선 = operating circulation
인력 효율 = staffing efficiency
상품 구성 = product configuration
유통 채널 = distribution channel
가격 전략 = pricing strategy`;

const hospitalityPreset = GLOSSARY_PRESETS.find((entry) => entry.id === "hotel-investment-en-ko");
if (hospitalityPreset && !hospitalityPreset.glossary.includes("[번역 메모리 — Hospitality Market Session 2026 문장 매칭]")) {
  hospitalityPreset.glossary = `${hospitalityPreset.glossary}\n\n${HOSPITALITY_TRANSLATION_MEMORY}`;
}
if (hospitalityPreset && !hospitalityPreset.glossary.includes("[추가 2026-06-23 — Hospitality Market Session 패널 3사 고유명사/약어/운영 용어]")) {
  hospitalityPreset.glossary = `${hospitalityPreset.glossary}\n\n${HOSPITALITY_PANEL_260623_TERMS}`;
}

/** The preset an untouched install runs with. Event-specific termbases (hotel,
 *  F&B) are one-click switches FROM this, never the starting point — resolution
 *  used to take the first pair match, and hotel-investment-en-ko is listed
 *  before the library, so a fresh install silently defaulted every EN↔KO session
 *  to the hotel glossary (MRG, RevPAR, hotel translation memory). */
export const DEFAULT_GLOSSARY_PRESET_ID = "default-cre-ai-en-ko";

export function getDefaultSubtitleGlossaryContext(languagePair = {}) {
  const a = normalizePresetLanguage(languagePair.a) || "en";
  const b = normalizePresetLanguage(languagePair.b) || "ko";
  const targetSet = new Set([a, b]);
  const matchesPair = (entry) => {
    const pairSet = new Set([entry.languagePair.a, entry.languagePair.b]);
    return pairSet.size === targetSet.size && [...targetSet].every((language) => pairSet.has(language));
  };
  // The designated default wins for its own language pair; every other pair
  // falls back to the first prepared preset that covers it.
  const preset = GLOSSARY_PRESETS.find((entry) => entry.id === DEFAULT_GLOSSARY_PRESET_ID && matchesPair(entry))
    ?? GLOSSARY_PRESETS.find(matchesPair);
  if (!preset) return { glossary: "", domain: "" };
  return { glossary: preset.glossary, domain: preset.domain };
}

function normalizePresetLanguage(value) {
  const code = String(value ?? "").trim().toLowerCase();
  if (code === "english") return "en";
  if (code === "korean") return "ko";
  if (code === "japanese") return "ja";
  if (["en", "ko", "ja"].includes(code)) return code;
  return "";
}
