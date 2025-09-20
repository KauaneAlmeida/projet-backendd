"""
FastAPI Backend Application

Main entry point for the FastAPI application with CORS middleware,
error handling, and route registration.
"""

from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
import logging
import os
from dotenv import load_dotenv

# Import routes
from app.routes.chat import router as chat_router
from app.routes.conversation import router as conversation_router
from app.routes.whatsapp import router as whatsapp_router
from app.routes.leads import router as leads_router

# Import services for startup
from app.services.firebase_service import initialize_firebase
from app.services.baileys_service import baileys_service

# Load environment variables from .env file
load_dotenv()

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Create FastAPI instance
app = FastAPI(
    title="Law Firm AI Chat Backend",
    description="Production-ready FastAPI backend for law firm client intake with WhatsApp integration",
    version="2.0.0"
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:8080",
        "http://localhost:3000", 
        "http://frontend:80",
        "http://127.0.0.1:8080",
        "*"  # Allow all for development - configure for production
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(chat_router, prefix="/api/v1", tags=["Chat"])
app.include_router(conversation_router, prefix="/api/v1", tags=["Conversation"])
app.include_router(whatsapp_router, prefix="/api/v1", tags=["WhatsApp"])
app.include_router(leads_router, prefix="/api/v1", tags=["Leads"])

# -------------------------
# Startup & Shutdown Events
# -------------------------
@app.on_event("startup")
async def startup_event():
    """Initialize services on startup."""
    logger.info("🚀 Starting up FastAPI application...")
    
    try:
        # Initialize Firebase
        try:
            initialize_firebase()
            logger.info("✅ Firebase initialized successfully")
        except Exception as firebase_error:
            logger.error(f"❌ Firebase initialization failed: {str(firebase_error)}")
            # Don't exit - let the app start but log the error
        
        # Initialize Baileys service connection
        try:
            await baileys_service.initialize()
            logger.info("✅ Baileys WhatsApp service connection initialized")
        except Exception as baileys_error:
            logger.error(f"❌ Baileys initialization failed: {str(baileys_error)}")
            # Don't exit - let the app start but log the error
        
    except Exception as e:
        logger.error(f"❌ Startup initialization failed: {str(e)}")
        # Don't exit - let the app start but log the error

@app.on_event("shutdown")
async def shutdown_event():
    """Cleanup services on shutdown."""
    logger.info("📴 Shutting down FastAPI application...")
    try:
        await baileys_service.cleanup()
        logger.info("✅ Services cleaned up successfully")
    except Exception as e:
        logger.warning(f"⚠️ Cleanup warning: {str(e)}")

# -------------------------
# Health Check
# -------------------------
@app.get("/health")
@app.head("/health")
async def health_check():
    """Health check endpoint for monitoring and load balancers."""
    try:
        # Get comprehensive service status from orchestrator
        from app.services.orchestration_service import intelligent_orchestrator
        service_status = await intelligent_orchestrator.get_overall_service_status()
        
        # Check WhatsApp bot status (non-critical)
        try:
            whatsapp_status = await baileys_service.get_connection_status()
        except Exception as e:
            logger.warning(f"⚠️ WhatsApp status check failed: {str(e)}")
            whatsapp_status = {"status": "error", "error": str(e)}
        
        return {
            "status": "healthy" if service_status["overall_status"] != "error" else "degraded",
            "message": "Law Firm AI Chat Backend is running",
            "overall_status": service_status["overall_status"],
            "services": {
                "fastapi": "active",
                "whatsapp_bot": whatsapp_status.get("status", "unknown"),
                "firebase": service_status["firebase_status"].get("status", "unknown"),
                "gemini_ai": service_status["ai_status"].get("status", "not_configured")
            },
            "features": [
                "guided_conversation_flow",
                "whatsapp_integration", 
                "ai_powered_responses" if service_status.get("gemini_available") else "fallback_responses",
                "lead_management",
                "session_persistence"
            ],
            "fallback_mode": service_status.get("fallback_mode", True),
            "phone_number": os.getenv("WHATSAPP_PHONE_NUMBER", "not-configured"),
            "uptime": "active",
            "detailed_status": service_status
        }
    except Exception as e:
        logger.error(f"Health check error: {str(e)}")
        # Always return a valid response, even on error
        return JSONResponse(
            status_code=200,  # Return 200 to prevent container restart
            content={
                "status": "error",
                "message": "Health check encountered errors",
                "overall_status": "error",
                "services": {
                    "fastapi": "active",
                    "whatsapp_bot": "unknown",
                    "firebase": "unknown", 
                    "gemini_ai": "unknown"
                },
                "features": [],
                "fallback_mode": True,
                "error": str(e),
                "uptime": "active"
            }
        )

# -------------------------
# Exception Handlers
# -------------------------
@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    logger.error(f"HTTP error {exc.status_code}: {exc.detail}")
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": True, "message": exc.detail, "status_code": exc.status_code},
    )

@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    logger.error(f"Validation error: {exc.errors()}")
    return JSONResponse(
        status_code=422,
        content={
            "error": True,
            "message": "Validation error",
            "details": exc.errors(),
            "status_code": 422,
        },
    )

@app.exception_handler(Exception)
async def general_exception_handler(request: Request, exc: Exception):
    logger.error(f"Unexpected error: {str(exc)}")
    return JSONResponse(
        status_code=500,
        content={"error": True, "message": "Internal server error", "status_code": 500},
    )

# -------------------------
# Root Endpoint
# -------------------------
@app.get("/")
async def root():
    return {
        "message": "Law Firm AI Chat Backend API",
        "version": "2.0.0",
        "docs_url": "/docs",
        "health_check": "/health",
        "endpoints": {
            "conversation_start": "/api/v1/conversation/start",
            "conversation_respond": "/api/v1/conversation/respond",
            "chat": "/api/v1/chat",
            "whatsapp_status": "/api/v1/whatsapp/status"
        }
    }

if __name__ == "__main__":
    import uvicorn
    # Define PORT constant for Cloud Run compatibility
    PORT = int(os.getenv("PORT", 8000))
    uvicorn.run("app.main:app", host="0.0.0.0", port=PORT, reload=True)