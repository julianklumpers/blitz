import {fromBase64} from "b64-lite"
import _BadBehavior from "bad-behavior"
import {useEffect, useState} from "react"
import {UrlObject} from "url"
import React, {ComponentPropsWithoutRef} from "react"
import {
  assert,
  deleteCookie,
  readCookie,
  isServer,
  isClient,
  createClientPlugin,
  AuthenticationError,
  RedirectError,
  RouteUrlObject,
  Ctx,
  CSRFTokenMismatchError,
} from "blitz"
import {
  COOKIE_CSRF_TOKEN,
  COOKIE_PUBLIC_DATA_TOKEN,
  LOCALSTORAGE_CSRF_TOKEN,
  LOCALSTORAGE_PREFIX,
  LOCALSTORAGE_PUBLIC_DATA_TOKEN,
  PublicData,
  EmptyPublicData,
  AuthenticatedClientSession,
  ClientSession,
  HEADER_CSRF,
  HEADER_PUBLIC_DATA_TOKEN,
  HEADER_SESSION_CREATED,
  HEADER_CSRF_ERROR,
} from "../shared"
import _debug from "debug"
import {formatWithValidation} from "../shared/url-utils"
import {ComponentType} from "react"
import {ComponentProps} from "react"

const BadBehavior: typeof _BadBehavior =
  "default" in _BadBehavior ? (_BadBehavior as any).default : _BadBehavior

const debug = _debug("blitz:auth-client")

export const parsePublicDataToken = (token: string) => {
  assert(token, "[parsePublicDataToken] Failed: token is empty")

  const publicDataStr = fromBase64(token)
  try {
    const publicData: PublicData = JSON.parse(publicDataStr)
    return {
      publicData,
    }
  } catch (error) {
    throw new Error(`[parsePublicDataToken] Failed to parse publicDataStr: ${publicDataStr}`)
  }
}

const emptyPublicData: EmptyPublicData = {userId: null, role: null}

class PublicDataStore {
  private eventKey = `${LOCALSTORAGE_PREFIX}publicDataUpdated`
  readonly observable = BadBehavior<PublicData | EmptyPublicData>()

  constructor() {
    if (typeof window !== "undefined") {
      // Set default value & prevent infinite loop
      this.updateState(undefined, {suppressEvent: true})
      window.addEventListener("storage", (event) => {
        if (event.key === this.eventKey) {
          // Prevent infinite loop
          this.updateState(undefined, {suppressEvent: true})
        }
      })
    }
  }

  updateState(value?: PublicData | EmptyPublicData, opts?: {suppressEvent: boolean}) {
    // We use localStorage as a message bus between tabs.
    // Setting the current time in ms will cause other tabs to receive the `storage` event
    if (!opts?.suppressEvent) {
      // Prevent infinite loop
      try {
        localStorage.setItem(this.eventKey, Date.now().toString())
      } catch (err) {
        console.error("LocalStorage is not available", err)
      }
    }
    this.observable.next(value ?? this.getData())
  }

  clear() {
    deleteCookie(COOKIE_PUBLIC_DATA_TOKEN())
    try {
      localStorage.removeItem(LOCALSTORAGE_PUBLIC_DATA_TOKEN())
    } catch (err) {
      console.error("LocalStorage is not available", err)
    }
    this.updateState(emptyPublicData)
  }

  getData() {
    const publicDataToken = this.getToken()
    if (!publicDataToken) {
      return emptyPublicData
    }

    const {publicData} = parsePublicDataToken(publicDataToken)
    return publicData
  }

  private getToken() {
    try {
      const cookieValue = readCookie(COOKIE_PUBLIC_DATA_TOKEN())
      if (cookieValue) {
        localStorage.setItem(LOCALSTORAGE_PUBLIC_DATA_TOKEN(), cookieValue)
        return cookieValue
      } else {
        return localStorage.getItem(LOCALSTORAGE_PUBLIC_DATA_TOKEN())
      }
    } catch (err) {
      console.error("LocalStorage is not available", err)
      return undefined
    }
  }
}
export const getPublicDataStore = (): PublicDataStore => {
  if (!(window as any).__publicDataStore) {
    ;(window as any).__publicDataStore = new PublicDataStore()
  }
  return (window as any).__publicDataStore
}

// because safari automatically deletes non-httponly cookies after 7 days
export const backupAntiCSRFTokenToLocalStorage = () => {
  const cookieValue = readCookie(COOKIE_CSRF_TOKEN())
  if (cookieValue) {
    localStorage.setItem(LOCALSTORAGE_CSRF_TOKEN(), cookieValue)
  }
}

export const getAntiCSRFToken = () => {
  const cookieValue = readCookie(COOKIE_CSRF_TOKEN())
  if (cookieValue) {
    return cookieValue
  } else {
    return localStorage.getItem(LOCALSTORAGE_CSRF_TOKEN())
  }
}

export interface UseSessionOptions {
  initialPublicData?: PublicData
  suspense?: boolean | null
}

export const useSession = (options: UseSessionOptions = {}): ClientSession => {
  const suspense = options?.suspense ?? Boolean(globalThis.__BLITZ_SUSPENSE_ENABLED)

  let initialState: ClientSession
  if (options.initialPublicData) {
    initialState = {...options.initialPublicData, isLoading: false}
  } else if (suspense) {
    if (isServer) {
      const e = new Error()
      e.name = "Rendering Suspense fallback..."
      delete e.stack
      throw e
    } else {
      initialState = {...getPublicDataStore().getData(), isLoading: false}
    }
  } else {
    initialState = {...emptyPublicData, isLoading: true}
  }

  const [session, setSession] = useState(initialState)

  useEffect(() => {
    // Initialize on mount
    setSession({...getPublicDataStore().getData(), isLoading: false})
    const subscription = getPublicDataStore().observable.subscribe((data) =>
      setSession({...data, isLoading: false}),
    )
    return subscription.unsubscribe
  }, [])

  return session
}

export const useAuthorizeIf = (condition?: boolean, role?: string | Array<string>) => {
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    setMounted(true)
  }, [])

  if (isClient && condition && !getPublicDataStore().getData().userId && mounted) {
    const error = new AuthenticationError()
    error.stack = null!
    throw error
  }

  if (isClient && condition && role && getPublicDataStore().getData().userId && mounted) {
    const error = new AuthenticationError()
    error.stack = null!
    if (!authorizeRole(role, getPublicDataStore().getData().role as string)) {
      throw error
    }
  }
}

const authorizeRole = (role?: string | Array<string>, currentRole?: string) => {
  if (role && currentRole) {
    if (Array.isArray(role)) {
      if (role.includes(currentRole)) {
        return true
      }
    } else {
      if (currentRole === role) {
        return true
      }
    }
  }
  return false
}

export const useAuthorize = () => {
  useAuthorizeIf(true)
}

export const useAuthenticatedSession = (
  options: UseSessionOptions = {},
): AuthenticatedClientSession => {
  useAuthorize()
  return useSession(options) as AuthenticatedClientSession
}

export const useRedirectAuthenticated = (to: UrlObject | string) => {
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  if (isClient && getPublicDataStore().getData().userId && mounted) {
    const error = new RedirectError(to)
    error.stack = null!
    throw error
  }
}

// export interface RouteUrlObject extends Pick<UrlObject, "pathname" | "query"> {
//   pathname: string
// }

export type RedirectAuthenticatedTo = string | RouteUrlObject | false
export type RedirectAuthenticatedToFnCtx = {
  session: Ctx["session"]["$publicData"]
}
export type RedirectAuthenticatedToFn = (
  args: RedirectAuthenticatedToFnCtx,
) => RedirectAuthenticatedTo

export type BlitzPage<P = {}> = React.ComponentType<P> & {
  getLayout?: (component: JSX.Element) => JSX.Element
  authenticate?: boolean | {redirectTo?: string | RouteUrlObject; role?: string | Array<string>}
  suppressFirstRenderFlicker?: boolean
  redirectAuthenticatedTo?: RedirectAuthenticatedTo | RedirectAuthenticatedToFn
}

export function getAuthValues<TProps = any>(
  Page: ComponentType<TProps> | BlitzPage,
  props: ComponentPropsWithoutRef<BlitzPage>,
) {
  if (!Page) return {}

  let authenticate = (Page as BlitzPage)?.authenticate
  let redirectAuthenticatedTo = (Page as BlitzPage)?.redirectAuthenticatedTo

  if (authenticate === undefined && redirectAuthenticatedTo === undefined) {
    const layout = "getLayout" in Page && Page.getLayout?.(<Page {...props} />)

    if (layout) {
      let currentElement = layout
      while (true) {
        const type = layout.type

        if (type.authenticate !== undefined || type.redirectAuthenticatedTo !== undefined) {
          authenticate = type.authenticate
          redirectAuthenticatedTo = type.redirectAuthenticatedTo
          break
        }

        if (currentElement.props?.children) {
          currentElement = currentElement.props?.children
        } else {
          break
        }
      }
    }
  }

  return {authenticate, redirectAuthenticatedTo}
}

function withBlitzAuthPlugin<TProps = any>(Page: ComponentType<TProps> | BlitzPage<TProps>) {
  const AuthRoot = (props: ComponentProps<any>) => {
    useSession({suspense: false})
    const [mounted, setMounted] = useState(false)

    useEffect(() => {
      setMounted(true)
    }, [])

    let {authenticate, redirectAuthenticatedTo} = getAuthValues(Page, props)
    useAuthorizeIf(
      !!authenticate &&
        ((typeof authenticate === "object" && authenticate.redirectTo === undefined) ||
          authenticate === true),
      !authenticate ? undefined : typeof authenticate === "object" ? authenticate.role : undefined,
    )
    if (typeof window !== "undefined") {
      const publicData = getPublicDataStore().getData()

      // We read directly from publicData.userId instead of useSession
      // so we can access userId on first render. useSession is always empty on first render
      if (publicData.userId) {
        debug("[BlitzAuthInnerRoot] logged in")

        if (typeof redirectAuthenticatedTo === "function") {
          redirectAuthenticatedTo = redirectAuthenticatedTo({
            session: publicData,
          })
        }

        if (redirectAuthenticatedTo) {
          const redirectUrl =
            typeof redirectAuthenticatedTo === "string"
              ? redirectAuthenticatedTo
              : formatWithValidation(redirectAuthenticatedTo)

          if (mounted) {
            debug("[BlitzAuthInnerRoot] redirecting to", redirectUrl)
            const error = new RedirectError(redirectUrl)
            error.stack = null!
            throw error
          }
        }

        if (
          authenticate &&
          typeof authenticate === "object" &&
          authenticate.redirectTo &&
          authenticate.role &&
          !authorizeRole(authenticate.role, publicData.role as string)
        ) {
          let {redirectTo} = authenticate
          if (typeof redirectTo !== "string") {
            redirectTo = formatWithValidation(redirectTo)
          }
          const url = new URL(redirectTo, window.location.href)
          url.searchParams.append("next", window.location.pathname)
          debug("[BlitzAuthInnerRoot] redirecting to", url.toString())
          const error = new RedirectError(url.toString())
          error.stack = null!
          throw error
        }
      } else {
        debug("[BlitzAuthInnerRoot] logged out")
        if (authenticate && typeof authenticate === "object" && authenticate.redirectTo) {
          let {redirectTo} = authenticate
          if (typeof redirectTo !== "string") {
            redirectTo = formatWithValidation(redirectTo)
          }

          const url = new URL(redirectTo, window.location.href)
          url.searchParams.append("next", window.location.pathname)

          if (mounted) {
            debug("[BlitzAuthInnerRoot] redirecting to", url.toString())
            const error = new RedirectError(url.toString())
            error.stack = null!
            throw error
          }
        }
      }
    }

    return <Page {...props} />
  }

  for (let [key, value] of Object.entries(Page)) {
    // @ts-ignore
    AuthRoot[key] = value
  }
  if (process.env.NODE_ENV !== "production") {
    AuthRoot.displayName = `BlitzAuthInnerRoot`
  }

  return AuthRoot
}

export interface AuthPluginClientOptions {
  cookiePrefix: string
}

export const AuthClientPlugin = createClientPlugin((options: AuthPluginClientOptions) => {
  globalThis.__BLITZ_SESSION_COOKIE_PREFIX = options.cookiePrefix || "blitz"
  return {
    withProvider: withBlitzAuthPlugin,
    events: {
      onRpcError: async (error) => {
        // We don't clear the publicDataStore for anonymous users,
        // because there is not sensitive data
        if (error.name === "AuthenticationError" && getPublicDataStore().getData().userId) {
          getPublicDataStore().clear()
        }
      },
    },
    middleware: {
      beforeHttpRequest(req) {
        const headers: Record<string, any> = {
          "Content-Type": "application/json",
        }
        const antiCSRFToken = getAntiCSRFToken()
        if (antiCSRFToken) {
          debug("Adding antiCSRFToken cookie header", antiCSRFToken)
          headers[HEADER_CSRF] = antiCSRFToken
        } else {
          debug("No antiCSRFToken cookie found")
        }
        req.headers = {...req.headers, ...headers}
        return req
      },
      beforeHttpResponse(res) {
        if (res.headers) {
          backupAntiCSRFTokenToLocalStorage()
          if (res.headers.get(HEADER_PUBLIC_DATA_TOKEN)) {
            getPublicDataStore().updateState()
            debug("Public data updated")
          }
          if (res.headers.get(HEADER_SESSION_CREATED)) {
            const event = new Event("blitz:session-created")
            document.dispatchEvent(event)
          }
          if (res.headers.get(HEADER_CSRF_ERROR)) {
            const err = new CSRFTokenMismatchError()
            err.stack = null!
            throw err
          }
        }
        return res
      },
    },
    exports: () => ({
      useSession,
      useAuthorize,
      useAuthorizeIf,
      useRedirectAuthenticated,
      useAuthenticatedSession,
      getAntiCSRFToken,
    }),
  }
})
