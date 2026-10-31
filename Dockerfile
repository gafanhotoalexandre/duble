FROM node:24-bookworm-slim AS frontend
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
COPY examples/ /build/examples/
RUN npm run build

FROM mcr.microsoft.com/dotnet/sdk:10.0.401-noble AS publish
WORKDIR /build
COPY global.json Directory.Build.props ./
COPY src/Duble.Api/Duble.Api.csproj src/Duble.Api/packages.lock.json src/Duble.Api/
RUN dotnet restore src/Duble.Api --locked-mode
COPY src/Duble.Api/ src/Duble.Api/
COPY --from=frontend /build/frontend/dist/ src/Duble.Api/wwwroot/
RUN dotnet publish src/Duble.Api --configuration Release --no-restore --output /app -p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:10.0.13-noble AS runtime
WORKDIR /app
COPY --from=publish /app/ ./
ENV ASPNETCORE_ENVIRONMENT=Production
USER $APP_UID
EXPOSE 8080
ENTRYPOINT ["dotnet", "Duble.Api.dll"]
