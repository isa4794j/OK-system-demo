# OK 시스템 — 애저 Container Apps 용 이미지 (azure-migration)
# Deno 공식 이미지. 로컬 deno 와 같은 판(2.9.6).
FROM denoland/deno:2.9.6

WORKDIR /app

# 의존성 먼저(바뀌지 않으면 캐시가 산다)
COPY deno.json deno.lock ./
COPY main.ts ./
COPY api ./api
COPY db ./db
COPY lib ./lib
COPY web ./web

# npm·jsr 의존성을 이미지 안에 미리 받아 둔다 — 컨테이너가 뜰 때 인터넷에서 받지 않게
RUN deno cache --frozen main.ts && chown -R deno:deno /app

USER deno

# Container Apps 가 PORT 를 넣어 준다(안 넣으면 8000). 수신 포트는 앱 설정에서 같은 값으로.
ENV PORT=8000
EXPOSE 8000

# 환경변수(값은 포털에서): DATABASE_URL · ANTHROPIC_API_KEY · NLK_API_KEY · DATA4LIBRARY_API_KEY · AUTH_ENFORCE
#   · ANALYSIS_SWEEP=interval(미분석 봉사일지 안전망 — 인스턴스 1개에서만)
# SUPABASE_URL·SUPABASE_KEY 는 DATABASE_URL 이 있으면 쓰지 않는다.
CMD ["deno", "run", "--cached-only", "--allow-net", "--allow-env", "--allow-read", "main.ts"]
